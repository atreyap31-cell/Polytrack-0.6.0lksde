// PolyTrack multiplayer server.
//
// Does two jobs:
//   1. Serves the game's static files (so `node server/server.js` is all you need to play).
//   2. Acts as the matchmaking ("signalling") server: hosts create an invite code, players join
//      with that code, and the server passes the WebRTC handshake between them. Once connected,
//      all gameplay traffic flows directly between the players' browsers, not through here.
//
// Environment variables:
//   PORT          port to listen on (default 8090)
//   ICE_SERVERS   JSON array of WebRTC ICE servers (default: public Google STUN servers).
//                 Add a TURN server here if some players are behind strict NATs/firewalls.
//   SERVE_STATIC  set to "0" to run as a signalling-only server (game hosted elsewhere)

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = parseInt(process.env.PORT || "8090", 10);
const SERVE_STATIC = process.env.SERVE_STATIC !== "0";
const STATIC_ROOT = path.resolve(__dirname, "..");
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_HOSTS = 500;
const JOIN_TIMEOUT_MS = 60 * 1000;

let ICE_SERVERS = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
if (process.env.ICE_SERVERS) {
	try {
		const parsed = JSON.parse(process.env.ICE_SERVERS);
		if (!Array.isArray(parsed)) throw new Error("not an array");
		ICE_SERVERS = parsed;
	} catch (e) {
		console.error("Ignoring invalid ICE_SERVERS:", e.message);
	}
}

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".wasm": "application/wasm",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".ico": "image/x-icon",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".glb": "model/gltf-binary",
	".ttf": "font/ttf",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".track": "text/plain; charset=utf-8"
};

// Folders of the repository that are never served to browsers.
const BLOCKED_TOP_LEVEL = new Set(["server", "node_modules", "electron", "tools"]);

function sendJson(res, status, body) {
	const data = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-store"
	});
	res.end(data);
}

function serveStatic(req, res, pathname) {
	let relative;
	try {
		relative = decodeURIComponent(pathname);
	} catch {
		res.writeHead(400);
		res.end("Bad request");
		return;
	}
	if (relative.endsWith("/")) relative += "index.html";
	const filePath = path.resolve(STATIC_ROOT, "." + relative);
	const inside = path.relative(STATIC_ROOT, filePath);
	const parts = inside.split(path.sep);
	if (inside.startsWith("..") || path.isAbsolute(inside) || parts.some((p) => p.startsWith(".")) || BLOCKED_TOP_LEVEL.has(parts[0])) {
		res.writeHead(404);
		res.end("Not found");
		return;
	}
	fs.stat(filePath, (err, stat) => {
		if (err || !stat.isFile()) {
			res.writeHead(404);
			res.end("Not found");
			return;
		}
		res.writeHead(200, {
			"Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
			"Content-Length": stat.size,
			"Cache-Control": "no-cache"
		});
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		fs.createReadStream(filePath).pipe(res);
	});
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://localhost");
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, OPTIONS",
			"Access-Control-Allow-Headers": "*"
		});
		res.end();
		return;
	}
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405);
		res.end("Method not allowed");
		return;
	}
	if (url.pathname === "/iceServers") return sendJson(res, 200, ICE_SERVERS);
	if (url.pathname === "/health") return sendJson(res, 200, { ok: true, hosts: hosts.size });
	if (!SERVE_STATIC) {
		res.writeHead(404);
		res.end("Not found");
		return;
	}
	serveStatic(req, res, url.pathname);
});

// ---------------------------------------------------------------------------------------------
// Signalling
// ---------------------------------------------------------------------------------------------

/** inviteCode -> { socket, key, joiners: Map<session, socket> } */
const hosts = new Map();

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid mix-ups

function randomCode(length) {
	const bytes = crypto.randomBytes(length);
	let out = "";
	for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
	return out;
}

function send(socket, message) {
	if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function parse(data, isBinary) {
	if (isBinary) return null;
	try {
		const message = JSON.parse(data.toString("utf8"));
		return message != null && typeof message === "object" ? message : null;
	} catch {
		return null;
	}
}

function cleanNickname(value) {
	if (typeof value !== "string") return "Player";
	const trimmed = value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 50);
	return trimmed.length > 0 ? trimmed : "Player";
}

function handleHost(socket) {
	let invite = null;

	socket.on("message", (data, isBinary) => {
		const message = parse(data, isBinary);
		if (message == null || typeof message.type !== "string") return socket.close();

		if (message.type === "createInvite") {
			if (invite != null) return socket.close();
			if (hosts.size >= MAX_HOSTS) {
				send(socket, { type: "error", error: "TotalHostLimit" });
				return socket.close();
			}
			let code;
			do {
				code = randomCode(5);
			} while (hosts.has(code));
			invite = { code, socket, key: randomCode(24), joiners: new Map() };
			hosts.set(code, invite);
			send(socket, {
				type: "createInvite",
				inviteCode: code,
				key: invite.key,
				timeoutMilliseconds: null,
				censoredNickname: typeof message.nickname === "string" ? cleanNickname(message.nickname) : null
			});
			return;
		}

		if (invite == null || typeof message.session !== "string") return;
		const joiner = invite.joiners.get(message.session);
		if (joiner == null) return;

		if (message.type === "acceptJoin") {
			if (typeof message.answer !== "string" || !Number.isSafeInteger(message.clientId)) return;
			send(joiner, {
				type: "acceptJoin",
				answer: message.answer,
				mods: [],
				isModsVanillaCompatible: true,
				clientId: message.clientId
			});
		} else if (message.type === "declineJoin") {
			send(joiner, { type: "declineJoin", reason: typeof message.reason === "string" ? message.reason : "Unknown" });
			joiner.close();
		} else if (message.type === "iceCandidate") {
			send(joiner, { type: "iceCandidate", candidate: message.candidate ?? null });
		}
	});

	socket.on("close", () => {
		if (invite == null) return;
		hosts.delete(invite.code);
		for (const joiner of invite.joiners.values()) joiner.close();
		invite.joiners.clear();
	});
}

function handleJoin(socket) {
	let invite = null;
	let session = null;
	const timeout = setTimeout(() => socket.close(), JOIN_TIMEOUT_MS);

	socket.on("message", (data, isBinary) => {
		const message = parse(data, isBinary);
		if (message == null) return socket.close();

		if (invite == null) {
			if (typeof message.inviteCode !== "string" || typeof message.offer !== "string") return socket.close();
			const found = hosts.get(message.inviteCode.trim().toUpperCase());
			if (found == null) {
				send(socket, { type: "error", error: "ExpiredInvite" });
				return socket.close();
			}
			invite = found;
			session = randomCode(16);
			invite.joiners.set(session, socket);
			send(invite.socket, {
				type: "joinInvite",
				session,
				offer: message.offer,
				mods: [],
				isModsVanillaCompatible: true,
				nickname: cleanNickname(message.nickname),
				countryCode: typeof message.countryCode === "string" ? message.countryCode : null,
				carStyle: typeof message.carStyle === "string" ? message.carStyle : "",
				iceServers: ICE_SERVERS
			});
			return;
		}

		if ("candidate" in message) {
			send(invite.socket, { type: "iceCandidate", session, candidate: message.candidate ?? null });
		}
	});

	socket.on("close", () => {
		clearTimeout(timeout);
		if (invite == null || session == null) return;
		if (invite.joiners.get(session) === socket) {
			invite.joiners.delete(session);
			send(invite.socket, { type: "joinDisconnect", session });
		}
	});
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

server.on("upgrade", (req, socket, head) => {
	const pathname = new URL(req.url, "http://localhost").pathname.replace(/\/+$/, "");
	const handler = pathname.endsWith("/multiplayer/host") ? handleHost : pathname.endsWith("/multiplayer/join") ? handleJoin : null;
	if (handler == null) {
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		ws.isAlive = true;
		ws.on("pong", () => {
			ws.isAlive = true;
		});
		ws.on("error", () => ws.close());
		handler(ws);
	});
});

// Drop dead connections so stale invite codes don't linger.
setInterval(() => {
	for (const ws of wss.clients) {
		if (ws.isAlive === false) {
			ws.terminate();
			continue;
		}
		ws.isAlive = false;
		ws.ping();
	}
}, 30000).unref();

server.listen(PORT, () => {
	console.log(`PolyTrack multiplayer server listening on http://localhost:${PORT}`);
	if (SERVE_STATIC) console.log(`Open http://localhost:${PORT}/ to play.`);
});
