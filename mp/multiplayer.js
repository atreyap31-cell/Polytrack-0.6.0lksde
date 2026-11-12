// PolyTrack multiplayer add-on (main thread).
//
// Adds three multiplayer modes on top of the game's built-in WebRTC multiplayer:
//   * Ghost Time Trial – everyone drives the same track, other cars are see-through ghosts.
//   * Race             – up to 5 players start together from a grid; cars collide; crash = restart.
//   * Tournament       – up to 8 players, random official tracks, random 1v1 knockout bracket.
// plus optional power-ups (Nitro, Super Grip, Shockwave) collected at checkpoints.
//
// The game's compiled bundle is patched (tools/patch-bundles.js) to call into this object at a
// few points. Physics-side effects (collisions, boost, grip) live in mp/worker-ext.js.

"use strict";

window.PTMP = (function () {
	const MODES = {
		ghost: { name: "Ghost Time Trial", maxPlayers: 5, desc: "Pick a track and chase the best time. Other players are ghosts: you can see them but drive straight through them." },
		race: { name: "Race", maxPlayers: 5, desc: "Everyone starts together from a grid. Cars collide and can knock each other off. Crash or reset and you restart from the grid. First across the line wins." },
		tour: { name: "Tournament", maxPlayers: 8, desc: "Knockout bracket on random official tracks. Players are randomly paired for 1v1 races; winners advance until one champion is left." }
	};
	const ITEMS = {
		nitro: { name: "Nitro", icon: "»", color: "#ff9a3c" },
		grip: { name: "Super Grip", icon: "◎", color: "#5ee1ff" },
		shock: { name: "Shockwave", icon: "✸", color: "#ff5b8a" }
	};
	// Grid slots in car-local metres [sideways, forwards]; checked on all 17 official tracks.
	const GRID = [[0, 0], [-2.2, -1.5], [2.2, -1.5], [-1.1, -6], [1.1, -6], [-3.2, -6], [3.2, -6], [0, -3]];
	const WORKER_MSG = 100;
	const COUNTDOWN_MS = 3000;
	const TOUR_MATCH_TIMEOUT_MS = 4 * 60 * 1000;
	const FINISH_GRACE_MS = 45 * 1000;

	const S = {
		mode: "ghost",
		powerups: false,
		pendingHostMode: "ghost",
		pendingHostPowerups: false,
		conn: null,
		isHost: false,
		ps: null,
		sessionId: null,
		restart: null,
		local: null,
		baseStart: null,
		collideCarId: null,
		race: null, // current race (see startRaceLocal)
		pendingRace: null,
		results: null,
		remote: new Map(), // playerId -> { hist: [], respawnUntil }
		hookedConns: new WeakSet(),
		item: null,
		rollUntil: 0,
		flipTime: 0,
		airTime: 0,
		lastUpdate: 0,
		host: null, // host-only bookkeeping
		tour: null, // last tournament state received
		ui: null
	};

	// ------------------------------------------------------------------------------------------
	// Small helpers
	// ------------------------------------------------------------------------------------------

	function serverUrl(kind, p) {
		const base = (window.PTMP_SERVER || location.origin).replace(/\/+$/, "");
		const u = new URL(base + "/" + p);
		if (kind === "ws") u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
		return u.href;
	}

	function rotate(q, v) {
		const x = q[0], y = q[1], z = q[2], w = q[3];
		const ix = w * v[0] + y * v[2] - z * v[1];
		const iy = w * v[1] + z * v[0] - x * v[2];
		const iz = w * v[2] + x * v[1] - y * v[0];
		const iw = -x * v[0] - y * v[1] - z * v[2];
		return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
	}

	function gridPosition(slot) {
		const b = S.baseStart;
		if (b == null) return null;
		const g = GRID[slot % GRID.length];
		const side = rotate(b.q, [1, 0, 0]);
		const fwd = rotate(b.q, [0, 0, 1]);
		return [b.p[0] + side[0] * g[0] + fwd[0] * g[1], b.p[1] + side[1] * g[0] + fwd[1] * g[1] + 0.05, b.p[2] + side[2] * g[0] + fwd[2] * g[1]];
	}

	function fmtTime(ms) {
		if (ms == null) return "--:--.---";
		ms = Math.max(0, Math.round(ms));
		const m = Math.floor(ms / 60000);
		const s = Math.floor((ms % 60000) / 1000);
		return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + String(ms % 1000).padStart(3, "0");
	}

	function shuffle(a) {
		for (let i = a.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[a[i], a[j]] = [a[j], a[i]];
		}
		return a;
	}

	function selfId() {
		try {
			return S.conn?.ptSelfId() ?? null;
		} catch {
			return null;
		}
	}

	function players() {
		try {
			return S.conn?.getPlayers() ?? [];
		} catch {
			return [];
		}
	}

	function nameOf(id) {
		const p = players().find((p) => p.id === id);
		if (p != null) return p.nickname;
		return S.tour?.names?.[id] ?? S.race?.names?.[id] ?? "Player " + id;
	}

	const isRaceMode = () => S.mode === "race" || S.mode === "tour";
	const amRacer = () => S.race != null && S.race.racers.includes(selfId());
	const racing = () => S.race != null && S.race.state === "racing";

	// ------------------------------------------------------------------------------------------
	// Networking (custom messages ride on the game's own reliable data channel, type 255)
	// ------------------------------------------------------------------------------------------

	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	function encode(msg) {
		const body = encoder.encode(JSON.stringify(msg));
		const out = new Uint8Array(body.length + 1);
		out[0] = 255;
		out.set(body, 1);
		return out;
	}

	/** Send a message. Host: to = player id or null for everyone. Client: always goes to the host. */
	function send(msg, to = null) {
		if (S.conn == null) return;
		const me = selfId();
		msg.from = me;
		if (S.isHost) {
			if (to == null || to === me) handle(me, msg);
			if (to !== me) S.conn.ptSend(to, encode(msg));
		} else {
			S.conn.ptSend(null, encode(msg));
		}
	}

	function relay(fromId, msg) {
		const bytes = encode(msg);
		for (const p of players()) if (!p.isSelf && p.id !== fromId) S.conn.ptSend(p.id, bytes);
	}

	function onCustom(conn, fromId, bytes) {
		let msg;
		try {
			msg = JSON.parse(decoder.decode(bytes.subarray(1)));
		} catch {
			return;
		}
		if (msg == null || typeof msg !== "object" || typeof msg.t !== "string") return;
		if (S.conn !== conn) {
			S.conn = conn;
			S.isHost = typeof conn.kickPlayer === "function";
		}
		if (fromId != null) msg.from = fromId; // host knows the true sender
		try {
			handle(msg.from, msg);
		} catch (e) {
			console.error("PTMP message error", e);
		}
	}

	function handle(from, msg) {
		switch (msg.t) {
			case "cfg":
				if (!S.isHost) {
					S.mode = MODES[msg.mode] ? msg.mode : "ghost";
					S.powerups = !!msg.powerups;
					if (msg.race != null && (S.race == null || S.race.id !== msg.race.id)) onRace(msg.race, true);
					if (msg.results != null) S.results = msg.results;
					if (msg.tour != null) S.tour = msg.tour;
					renderPanel();
				}
				break;
			case "race":
				if (!S.isHost || from === selfId()) onRace(msg, false);
				break;
			case "results":
				S.results = msg;
				if (msg.final && S.race != null && S.race.id === msg.id) S.race.state = "done";
				renderPanel();
				break;
			case "tour":
				S.tour = msg;
				if (msg.state !== "racing" && S.race != null && S.race.kind === "tour") S.race.state = "done";
				renderPanel();
				break;
			case "shock":
				if (S.isHost && from !== selfId()) relay(from, msg);
				if (from !== selfId()) onShock(msg);
				break;
			case "fx":
				if (S.isHost && from !== selfId()) relay(from, msg);
				if (from !== selfId()) toast(nameOf(from) + " used " + (ITEMS[msg.item]?.name ?? "an item"));
				break;
			case "ready":
				if (S.isHost) hostOnReady(from, msg);
				break;
			case "finish":
				if (S.isHost) hostOnFinish(from, msg);
				break;
			case "prog":
				if (S.isHost) hostOnProgress(from, msg);
				break;
		}
	}

	// ------------------------------------------------------------------------------------------
	// Hooks called from the patched game bundle
	// ------------------------------------------------------------------------------------------

	function engineGameMode(r) {
		S.mode = S.pendingHostMode;
		S.powerups = S.pendingHostPowerups;
		return isRaceMode() ? 1 /* Competitive */ : r;
	}

	function onHostCreated(conn) {
		S.conn = conn;
		S.isHost = true;
		S.race = null;
		S.results = null;
		S.tour = null;
		S.host = { raceId: 0, finishes: {}, progress: {}, firstFinishAt: null, ready: {}, tour: null, timers: [] };
		hookConnection(conn);
	}

	function hookConnection(conn) {
		if (S.hookedConns.has(conn)) return;
		S.hookedConns.add(conn);
		conn.addCarUpdateCallback((sessionId, playerId, resetCounter, state) => {
			if (sessionId !== S.sessionId) return;
			let r = S.remote.get(playerId);
			if (r == null) S.remote.set(playerId, (r = { hist: [], respawnUntil: 0, resetCounter }));
			if (resetCounter > r.resetCounter) {
				r.hist.length = 0;
				r.resetCounter = resetCounter;
				r.respawnUntil = performance.now() + 600;
			}
			const last = r.hist[r.hist.length - 1];
			if (last != null && state.frames <= last.f) return;
			r.hist.push({ f: state.frames, p: [state.position.x, state.position.y, state.position.z], q: [state.quaternion.x, state.quaternion.y, state.quaternion.z, state.quaternion.w], t: performance.now() });
			if (r.hist.length > 64) r.hist.splice(0, r.hist.length - 64);
		});
		conn.addCarResetCallback((sessionId, playerId, resetCounter) => {
			const r = S.remote.get(playerId);
			if (r != null) {
				r.hist.length = 0;
				r.resetCounter = resetCounter;
				r.respawnUntil = performance.now() + 600;
			}
		});
		conn.addPlayersChangedCallback(() => {
			if (S.isHost) hostOnPlayersChanged();
			renderPanel();
		});
	}

	function onPlayState(ps, sa, restart) {
		S.ps = ps;
		S.restart = restart;
		S.local = null;
		S.collideCarId = null;
		S.item = null;
		S.rollUntil = 0;
		if (sa == null) {
			S.sessionId = null;
			hideUI();
			return;
		}
		if (S.conn !== sa.multiplayerConnection) {
			S.conn = sa.multiplayerConnection;
			S.isHost = typeof S.conn.kickPlayer === "function";
			if (!S.isHost) {
				S.mode = "ghost";
				S.powerups = false;
				S.race = null;
				S.results = null;
				S.tour = null;
			}
		}
		hookConnection(S.conn);
		const newSession = S.sessionId !== sa.sessionId;
		S.sessionId = sa.sessionId;
		if (newSession) {
			S.remote.clear();
			if (S.race != null && S.race.session !== S.sessionId) S.race = null;
			if (S.results != null && S.results.session !== S.sessionId) S.results = null;
		}
		if (S.pendingRace != null && S.pendingRace.session === S.sessionId) {
			const r = S.pendingRace;
			S.pendingRace = null;
			setTimeout(() => onRace(r, false), 0);
		}
		ensureUI();
		if (S.isHost) {
			hostBroadcastConfig();
			hostOnSessionLoaded();
		} else {
			send({ t: "ready", session: S.sessionId });
		}
		renderPanel();
	}

	function onPlayStateDispose(ps) {
		if (S.ps !== ps) return;
		S.ps = null;
		S.local = null;
		hideUI();
	}

	function localStart(t) {
		if (t == null) return t;
		S.baseStart = { p: [t.position.x, t.position.y, t.position.z], q: [t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w] };
		if (S.ps == null || S.sessionId == null || !isRaceMode() || S.race == null || S.race.state === "done") return t;
		const slot = S.race.slots[selfId()];
		if (slot == null) return t;
		const g = gridPosition(slot);
		t.position.set(g[0], g[1], g[2]);
		t.ptGrid = true;
		return t;
	}

	function onLocalCar(car) {
		S.local = car;
		S.collideCarId = null;
		S.flipTime = 0;
		S.airTime = 0;
		if (S.race != null && racing() && amRacer() && !S.race.finished) {
			S.race.offsetMs = performance.now() - S.race.startAt;
		}
		car.addFinishCallback((c) => onLocalFinish(c));
		car.addCheckpointCallback((index) => onLocalCheckpoint(index));
	}

	function wantStart(input) {
		if (S.ps == null || !isRaceMode() || S.race == null || !amRacer()) return input;
		if (S.race.state === "countdown") return false;
		if (S.race.state === "racing") return true;
		return input;
	}

	const noCheckpointReset = () => S.ps != null && isRaceMode() && racing() && amRacer();
	const blockRecords = () => S.ps != null && (isRaceMode() || S.powerups);
	const flushMs = () => (S.pendingHostMode === "ghost" ? 100 : 33);
	const renderDelay = () => (S.ps != null && isRaceMode() ? 0.08 : 0.15);

	function opacity(dist) {
		if (S.ps != null && isRaceMode() && racing()) return 1;
		return Math.max(0.25, Math.min(0.7, dist / 5));
	}

	// ------------------------------------------------------------------------------------------
	// Races
	// ------------------------------------------------------------------------------------------

	function onRace(msg, late) {
		if (msg.session !== S.sessionId) {
			S.pendingRace = msg;
			return;
		}
		const now = performance.now();
		S.race = {
			id: msg.id,
			session: msg.session,
			kind: msg.kind,
			racers: msg.racers,
			slots: msg.slots,
			opp: msg.opp || null,
			names: msg.names || {},
			state: late ? "spectating" : "countdown",
			goAt: now + (msg.countdownMs ?? COUNTDOWN_MS),
			startAt: 0,
			offsetMs: 0,
			finished: false
		};
		S.results = null;
		S.item = null;
		S.rollUntil = 0;
		if (!late && amRacer() && S.restart != null) S.restart();
		renderPanel();
	}

	function onLocalFinish(car) {
		if (S.race == null || !racing() || !amRacer() || S.race.finished) return;
		const t = car.getFinishTime();
		if (t == null) return;
		S.race.finished = true;
		const ms = Math.round(S.race.offsetMs + t.numberOfFrames);
		S.race.myTime = ms;
		send({ t: "finish", id: S.race.id, ms });
		toast("Finished! " + fmtTime(ms));
		renderPanel();
	}

	function onLocalCheckpoint(index) {
		if (S.race != null && racing() && amRacer() && !S.race.finished) send({ t: "prog", id: S.race.id, cp: index + 1 });
		if (!S.powerups || S.item != null || S.rollUntil > 0) return;
		if (isRaceMode() && !(racing() && amRacer())) return;
		S.rollUntil = performance.now() + 1200;
		renderItem();
	}

	function opponentsOf(me) {
		if (S.race == null) return [];
		if (S.race.opp != null) {
			const o = S.race.opp[me];
			return o == null ? [] : [o];
		}
		return S.race.racers.filter((id) => id !== me);
	}

	function remotePose(id, now) {
		const r = S.remote.get(id);
		if (r == null || r.hist.length === 0) return null;
		const last = r.hist[r.hist.length - 1];
		let v = [0, 0, 0];
		for (let i = r.hist.length - 2; i >= 0; i--) {
			const e = r.hist[i];
			const df = last.f - e.f;
			if (df >= 10) {
				const k = 1000 / df;
				v = [(last.p[0] - e.p[0]) * k, (last.p[1] - e.p[1]) * k, (last.p[2] - e.p[2]) * k];
				break;
			}
		}
		const age = (now - last.t) / 1000;
		if (age > 1) return null; // stale: that player has stopped sending (paused tab, lag spike)
		const lead = Math.min(0.25, age + 0.04);
		return {
			id,
			p: [last.p[0] + v[0] * lead, last.p[1] + v[1] * lead, last.p[2] + v[2] * lead],
			q: last.q,
			v,
			respawned: now < r.respawnUntil
		};
	}

	function postToWorker(msg) {
		const car = S.local;
		if (car == null) return;
		const sim = car.ptSim?.();
		const id = car.ptCarId?.();
		if (sim == null || id == null) return;
		msg.messageType = WORKER_MSG;
		msg.carId = id;
		sim.ptPost(msg);
	}

	function update(ps) {
		if (ps !== S.ps || S.sessionId == null) return;
		const now = performance.now();
		const dt = S.lastUpdate === 0 ? 0 : Math.min(0.1, (now - S.lastUpdate) / 1000);
		S.lastUpdate = now;
		const me = selfId();
		const race = S.race;

		if (race != null && race.state === "countdown" && now >= race.goAt) {
			race.state = "racing";
			race.startAt = race.goAt;
			race.offsetMs = 0;
			if (amRacer()) toast("GO!", 700, true);
			renderPanel();
		}

		// Remote cars: who is visible, and where they wait before the start.
		const remote = ps.ptRemote?.();
		if (remote != null) {
			const inMatch = race != null && race.opp != null && amRacer() && race.state !== "done";
			const opp = inMatch ? race.opp[me] : null;
			for (const [id, entry] of remote) {
				entry.car.setVisible(!inMatch || id === opp);
				if (race != null && race.state === "countdown" && race.slots[id] != null) {
					const r = S.remote.get(id);
					const fresh = r != null && r.hist.length > 0 && r.hist[r.hist.length - 1].t > race.goAt - COUNTDOWN_MS;
					if (!fresh) {
						const g = gridPosition(race.slots[id]);
						const st = entry.car.getCarState();
						if (g != null && st != null && Math.hypot(st.position.x - g[0], st.position.z - g[2]) > 0.05) {
							const copy = Object.assign({}, st, { position: { x: g[0], y: g[1] - 0.05, z: g[2] }, quaternion: { x: S.baseStart.q[0], y: S.baseStart.q[1], z: S.baseStart.q[2], w: S.baseStart.q[3] } });
							entry.car.setCarState(copy, true);
							entry.bufferedCarStates.length = 0;
						}
					}
				}
			}
		}

		// Car-to-car contact while racing.
		const local = S.local;
		const shouldCollide = local != null && isRaceMode() && racing() && amRacer() && local.hasStarted();
		const carId = local?.ptCarId?.() ?? null;
		if (shouldCollide) {
			if (S.collideCarId !== carId) {
				postToWorker({ op: "collide", enabled: true });
				S.collideCarId = carId;
			}
			const cars = [];
			for (const id of opponentsOf(me)) {
				const pose = remotePose(id, now);
				if (pose != null) cars.push(pose);
			}
			postToWorker({ op: "others", cars });
		} else if (S.collideCarId != null && S.collideCarId === carId) {
			postToWorker({ op: "collide", enabled: false });
			S.collideCarId = null;
		}

		// Crash detection: flipped over or airborne for too long means a restart in race modes.
		if (shouldCollide && !race.finished && dt > 0) {
			const q = local.getQuaternion();
			const up = rotate([q.x, q.y, q.z, q.w], [0, 1, 0]);
			const st = local.getCarState();
			const grounded = st.wheelContact.some((w) => w != null);
			S.flipTime = up[1] < 0.25 && st.speedKmh < 25 ? S.flipTime + dt : 0;
			S.airTime = grounded ? 0 : S.airTime + dt;
			if (S.flipTime > 1.5 || S.airTime > 7) {
				S.flipTime = 0;
				S.airTime = 0;
				toast("Crashed! Restarting…");
				S.restart?.();
			}
		}

		// Item roulette.
		if (S.rollUntil > 0 && now >= S.rollUntil) {
			S.rollUntil = 0;
			const pool = isRaceMode() ? ["nitro", "nitro", "grip", "shock"] : ["nitro", "nitro", "grip"];
			S.item = pool[Math.floor(Math.random() * pool.length)];
			renderItem();
		} else if (S.rollUntil > 0) {
			renderItem();
		}

		if (S.isHost) hostTick(now);
		renderClock(now);
	}

	function onWorkerMessage(msg) {
		if (!Array.isArray(msg.hits) || S.local == null || msg.carId !== S.local.ptCarId?.()) return;
		for (const h of msg.hits) {
			S.hitCount = (S.hitCount || 0) + 1;
			if (h.speed > 4) {
				toast(h.speed > 12 ? "SMASH!" : "Bump!", 600);
				flash("rgba(255,255,255,0.6)");
			}
		}
	}

	// ------------------------------------------------------------------------------------------
	// Power-ups
	// ------------------------------------------------------------------------------------------

	function useItem() {
		const car = S.local;
		if (S.item == null || car == null || !car.hasStarted() || car.hasFinished()) return;
		const item = S.item;
		S.item = null;
		if (item === "nitro") {
			postToWorker({ op: "boost", frames: 1300, accel: 22 });
		} else if (item === "grip") {
			postToWorker({ op: "grip", frames: 6000, strength: 0.02 });
		} else if (item === "shock") {
			const p = car.getPosition();
			send({ t: "shock", p: [p.x, p.y, p.z], session: S.sessionId });
			postToWorker({ op: "boost", frames: 400, accel: 15 });
		}
		send({ t: "fx", item });
		toast(ITEMS[item].name + "!", 900, true);
		flash(ITEMS[item].color);
		renderItem();
	}

	function onShock(msg) {
		if (msg.session !== S.sessionId || S.local == null || !racing() || !amRacer()) return;
		if (S.race.opp != null && S.race.opp[selfId()] !== msg.from) return;
		const p = S.local.getPosition();
		const d = [p.x - msg.p[0], p.z - msg.p[2]];
		const dist = Math.hypot(d[0], d[1]);
		if (dist > 15 || Math.abs(p.y - msg.p[1]) > 6) return;
		const strength = 11 * (1 - dist / 15) + 3;
		const n = dist < 0.01 ? [1, 0] : [d[0] / dist, d[1] / dist];
		postToWorker({ op: "impulse", dv: [n[0] * strength, 4, n[1] * strength], dw: [0, (Math.random() - 0.5) * 5, 0] });
		toast("Hit by " + nameOf(msg.from) + "'s Shockwave!");
		flash(ITEMS.shock.color);
	}

	window.addEventListener("keydown", (e) => {
		if (S.ps == null || e.repeat) return;
		const el = document.activeElement;
		const typing = el != null && el.offsetParent !== null && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["range", "checkbox", "radio", "button"].includes(el.type)));
		if (typing) return;
		if (e.code === "KeyE") {
			useItem();
			e.preventDefault();
		}
	});

	// ------------------------------------------------------------------------------------------
	// Host logic
	// ------------------------------------------------------------------------------------------

	function hostConfigMessage() {
		return { t: "cfg", mode: S.mode, powerups: S.powerups, race: S.race != null && S.race.state !== "done" ? S.host.lastRaceMsg : null, results: S.results, tour: S.tour };
	}

	function hostBroadcastConfig() {
		if (!S.isHost || S.conn == null) return;
		const msg = hostConfigMessage();
		msg.from = selfId();
		S.conn.ptSend(null, encode(msg));
	}

	function hostOnPlayersChanged() {
		hostBroadcastConfig();
		const ids = new Set(players().map((p) => p.id));
		const H = S.host;
		// Players who left a running race count as did-not-finish; in a tournament their opponent wins.
		if (S.race != null && S.race.state !== "done") {
			for (const id of S.race.racers) if (!ids.has(id) && !(id in H.finishes)) H.finishes[id] = null;
			hostCheckRaceOver();
		}
		const T = H.tour;
		if (T != null && T.state !== "done") {
			T.alive = T.alive.filter((id) => ids.has(id));
			if (T.state === "racing") hostCheckMatches();
			if (T.alive.length <= 1 && T.state !== "racing") hostFinishTournament();
			hostSendTour();
		}
	}

	function hostStartRace(kind, racers, opp) {
		const H = S.host;
		H.raceId++;
		H.finishes = {};
		H.progress = {};
		H.firstFinishAt = null;
		const slots = {};
		if (opp != null) {
			for (const id of racers) slots[id] = 1;
			const seen = new Set();
			for (const id of racers) {
				const o = opp[id];
				if (o != null && !seen.has(id)) {
					slots[id] = 1;
					slots[o] = 2;
					seen.add(id).add(o);
				}
			}
		} else {
			shuffle(racers.slice()).forEach((id, i) => (slots[id] = i));
		}
		const names = {};
		for (const p of players()) names[p.id] = p.nickname;
		const msg = { t: "race", id: H.raceId, kind, session: S.sessionId, racers, slots, opp, names, countdownMs: COUNTDOWN_MS };
		H.lastRaceMsg = msg;
		H.raceStartedAt = performance.now() + COUNTDOWN_MS;
		send(msg);
	}

	function hostOnFinish(from, msg) {
		const H = S.host;
		if (S.race == null || msg.id !== H.raceId || !S.race.racers.includes(from) || from in H.finishes) return;
		H.finishes[from] = typeof msg.ms === "number" ? msg.ms : null;
		if (H.firstFinishAt == null) H.firstFinishAt = performance.now();
		if (H.tour != null && H.tour.state === "racing") hostCheckMatches();
		else hostSendResults(false);
		hostCheckRaceOver();
	}

	function hostOnProgress(from, msg) {
		if (msg.id === S.host.raceId && typeof msg.cp === "number") S.host.progress[from] = Math.max(S.host.progress[from] ?? 0, msg.cp);
	}

	function hostSendResults(final) {
		const H = S.host;
		if (S.race == null) return;
		const list = S.race.racers.map((id) => ({ id, name: nameOf(id), ms: H.finishes[id] ?? null, done: id in H.finishes, cp: H.progress[id] ?? 0 }));
		list.sort((a, b) => (a.ms == null) - (b.ms == null) || (a.ms ?? 0) - (b.ms ?? 0) || b.cp - a.cp);
		send({ t: "results", id: H.raceId, session: S.sessionId, final, list });
	}

	function hostCheckRaceOver() {
		const H = S.host;
		if (S.race == null || S.race.state === "done" || (H.tour != null && H.tour.state === "racing")) return;
		const allDone = S.race.racers.every((id) => id in H.finishes);
		const graceOver = H.firstFinishAt != null && performance.now() - H.firstFinishAt > FINISH_GRACE_MS;
		if (allDone || graceOver) hostEndRace();
	}

	function hostEndRace() {
		if (S.race == null || S.race.state === "done") return;
		for (const id of S.race.racers) if (!(id in S.host.finishes)) S.host.finishes[id] = null;
		S.race.state = "done";
		S.host.lastRaceMsg = null;
		hostSendResults(true);
		renderPanel();
	}

	function hostTick(now) {
		const H = S.host;
		if (H == null) return;
		if (S.race != null && S.race.state === "racing" && (H.tour == null || H.tour.state !== "racing")) hostCheckRaceOver();
		const T = H.tour;
		if (T == null) return;
		if (T.state === "loading" && T.loadedAt != null) {
			const everyone = T.alive.every((id) => id === selfId() || H.ready[S.sessionId]?.has(id));
			if ((everyone && now - T.loadedAt > 1500) || now - T.loadedAt > 12000) hostBeginMatches();
		} else if (T.state === "racing") {
			hostCheckMatches();
		} else if (T.state === "between" && now >= T.nextAt) {
			if (T.alive.length <= 1) hostFinishTournament();
			else hostNextRound();
		}
	}

	function hostOnReady(from, msg) {
		const H = S.host;
		(H.ready[msg.session] ??= new Set()).add(from);
	}

	// --- tournament ---

	function hostStartTournament() {
		const ps = players();
		if (ps.length < 2) {
			toast("Need at least 2 players for a tournament");
			return;
		}
		if (!Array.isArray(PTMP.officialTracks) || PTMP.officialTracks.length === 0) {
			toast("Official tracks are still loading, try again in a moment");
			return;
		}
		const names = {};
		for (const p of ps) names[p.id] = p.nickname;
		S.host.tour = { state: "between", round: 0, alive: shuffle(ps.map((p) => p.id)), names, matches: [], history: [], usedTracks: [], nextAt: performance.now() + 500, champion: null, trackName: null };
		hostSendTour();
	}

	function hostNextRound() {
		const T = S.host.tour;
		T.round++;
		const order = shuffle(T.alive.slice());
		T.matches = [];
		for (let i = 0; i + 1 < order.length; i += 2) T.matches.push({ a: order[i], b: order[i + 1], winner: null, decidedBy: null });
		if (order.length % 2 === 1) T.matches.push({ a: order[order.length - 1], b: null, winner: order[order.length - 1], decidedBy: "bye" });
		const tracks = PTMP.officialTracks;
		let choices = tracks.filter((t) => !T.usedTracks.includes(t.trackMetadata.name));
		if (choices.length === 0) {
			T.usedTracks = [];
			choices = tracks;
		}
		const track = choices[Math.floor(Math.random() * choices.length)];
		T.usedTracks.push(track.trackMetadata.name);
		T.trackName = track.trackMetadata.name;
		T.state = "loading";
		T.loadedAt = null;
		S.race = null;
		hostSendTour();
		S.conn.startNewSession(1, track.trackMetadata, track.trackData);
	}

	function hostOnSessionLoaded() {
		const T = S.host?.tour;
		if (T != null && T.state === "loading" && T.loadedAt == null) T.loadedAt = performance.now();
		const R = S.host;
		if (R != null && S.race == null) R.lastRaceMsg = null;
	}

	function hostBeginMatches() {
		const T = S.host.tour;
		T.state = "racing";
		T.matchStartedAt = performance.now();
		const racers = [];
		const opp = {};
		for (const m of T.matches) {
			if (m.b == null) continue;
			racers.push(m.a, m.b);
			opp[m.a] = m.b;
			opp[m.b] = m.a;
		}
		hostSendTour();
		hostStartRace("tour", racers, opp);
	}

	function hostCheckMatches() {
		const H = S.host;
		const T = H.tour;
		if (T == null || T.state !== "racing") return;
		const now = performance.now();
		const present = new Set(players().map((p) => p.id));
		let changed = false;
		for (const m of T.matches) {
			if (m.winner != null) continue;
			const fa = H.finishes[m.a];
			const fb = H.finishes[m.b];
			const aGone = !present.has(m.a);
			const bGone = !present.has(m.b);
			let w = null;
			let how = null;
			if (aGone || bGone) {
				w = aGone && bGone ? null : aGone ? m.b : m.a;
				how = "opponent left";
				if (w == null) {
					m.winner = -1;
					changed = true;
					continue;
				}
			} else if (fa != null && fb != null) {
				w = fa <= fb ? m.a : m.b;
				how = "race";
			} else if ((fa != null || fb != null) && H.firstFinishAt != null && now - H.firstFinishAt > FINISH_GRACE_MS) {
				w = fa != null ? m.a : m.b;
				how = "race";
			} else if (fa != null && m.b in H.finishes) {
				w = m.a;
				how = "race";
			} else if (fb != null && m.a in H.finishes) {
				w = m.b;
				how = "race";
			} else if (now - T.matchStartedAt > TOUR_MATCH_TIMEOUT_MS) {
				const pa = H.progress[m.a] ?? 0;
				const pb = H.progress[m.b] ?? 0;
				w = pa === pb ? (Math.random() < 0.5 ? m.a : m.b) : pa > pb ? m.a : m.b;
				how = "time limit";
			}
			if (w != null) {
				m.winner = w;
				m.decidedBy = how;
				m.times = { [m.a]: fa ?? null, [m.b]: fb ?? null };
				changed = true;
			}
		}
		if (T.matches.every((m) => m.winner != null)) {
			const winners = new Set(T.matches.map((m) => m.winner).filter((w) => w != null && w !== -1));
			T.alive = T.alive.filter((id) => winners.has(id));
			T.history.push({ round: T.round, track: T.trackName, matches: T.matches.map((m) => Object.assign({}, m)) });
			T.state = "between";
			T.nextAt = now + 8000;
			if (S.race != null) S.race.state = "done";
			H.lastRaceMsg = null;
			changed = true;
		}
		if (changed) hostSendTour();
	}

	function hostFinishTournament() {
		const T = S.host.tour;
		T.state = "done";
		T.champion = T.alive.length === 1 ? T.alive[0] : null;
		hostSendTour();
	}

	function hostSendTour() {
		const T = S.host.tour;
		if (T == null) return;
		for (const p of players()) if (!(p.id in T.names)) T.names[p.id] = p.nickname;
		send({ t: "tour", state: T.state, round: T.round, alive: T.alive, names: T.names, matches: T.matches, history: T.history, champion: T.champion, trackName: T.trackName, nextAt: T.state === "between" ? Date.now() + Math.max(0, T.nextAt - performance.now()) : null });
	}

	// ------------------------------------------------------------------------------------------
	// UI
	// ------------------------------------------------------------------------------------------

	const CSS = `
	.ptmp { font-family: ForcedSquare, Arial, sans-serif; color: #fff; }
	.ptmp-panel { position: absolute; right: 8px; top: 8px; z-index: 5; width: 300px; max-width: calc(100vw - 16px); box-sizing: border-box;
		background: rgba(33, 43, 88, 0.88); border-left: 4px solid var(--ptmp-accent, #5ee1ff); padding: 8px 12px 10px; pointer-events: auto; user-select: none; }
	.ptmp-panel.collapsed .ptmp-body { display: none; }
	.ptmp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; }
	.ptmp-title { font-size: 20px; }
	.ptmp-tag { font-size: 13px; padding: 1px 6px; background: rgba(255,255,255,0.12); white-space: nowrap; }
	.ptmp-status { font-size: 15px; opacity: 0.9; margin: 6px 0; }
	.ptmp-list { margin: 4px 0 0; padding: 0; list-style: none; font-size: 15px; }
	.ptmp-list li { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.08); }
	.ptmp-list li.me { color: #ff5; }
	.ptmp-list .muted { opacity: 0.6; }
	.ptmp-match { font-size: 14px; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.08); }
	.ptmp-match .w { color: #5f5; }
	.ptmp-match .l { opacity: 0.55; text-decoration: line-through; }
	.ptmp-btn { display: block; width: 100%; margin-top: 8px; padding: 6px 8px; font: inherit; font-size: 17px; color: #fff; background: #112052;
		border: none; cursor: pointer; }
	.ptmp-btn:hover { background: #334b77; }
	.ptmp-btn:disabled { opacity: 0.5; cursor: default; }
	.ptmp-hint { font-size: 12px; opacity: 0.7; margin-top: 6px; }
	.ptmp-countdown { position: absolute; left: 0; right: 0; top: 30%; text-align: center; font-size: 120px; z-index: 5; pointer-events: none;
		text-shadow: 4px 4px 0 #112052, 0 0 12px rgba(0,0,0,0.6); }
	.ptmp-clock { position: absolute; left: 50%; transform: translateX(-50%); bottom: 64px; z-index: 5; font-size: 22px; padding: 2px 12px;
		background: rgba(33, 43, 88, 0.85); pointer-events: none; }
	.ptmp-item { position: absolute; right: 12px; bottom: 70px; z-index: 5; width: 84px; height: 84px; display: flex; flex-direction: column;
		align-items: center; justify-content: center; background: rgba(17, 32, 82, 0.9); border: 3px solid rgba(255,255,255,0.35); pointer-events: auto; cursor: pointer; }
	.ptmp-item .icon { font-size: 40px; line-height: 1; }
	.ptmp-item .label { font-size: 12px; margin-top: 4px; }
	.ptmp-item.rolling { animation: ptmp-roll 0.12s linear infinite; }
	@keyframes ptmp-roll { 50% { border-color: #ff5; } }
	.ptmp-toast { position: absolute; left: 50%; top: 18%; transform: translateX(-50%); z-index: 6; font-size: 26px; padding: 4px 16px;
		background: rgba(33, 43, 88, 0.9); pointer-events: none; white-space: nowrap; transition: opacity 0.3s; }
	.ptmp-toast.big { font-size: 64px; background: none; text-shadow: 4px 4px 0 #112052; }
	.ptmp-flash { position: absolute; inset: 0; z-index: 4; pointer-events: none; opacity: 0; transition: opacity 0.5s; }
	.ptmp-host-opts { margin: 0; padding: 10px 20px; background: var(--surface-secondary-color, #212b58); }
	.ptmp-host-opts .title { font-size: 18px; margin-bottom: 4px; }
	.ptmp-host-opts .row { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
	.ptmp-host-opts .button.selected { background-color: var(--button-hover-color, #334b77); }
	.ptmp-host-opts .info { font-size: 14px; opacity: 0.85; }
	@media (max-width: 700px) { .ptmp-panel { width: 220px; } .ptmp-countdown { font-size: 80px; } }
	`;

	function ensureUI() {
		if (S.ui != null) {
			S.ui.root.style.display = "";
			return;
		}
		const style = document.createElement("style");
		style.textContent = CSS;
		document.head.appendChild(style);
		const root = document.createElement("div");
		root.className = "ptmp";
		root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:3;";
		root.innerHTML =
			'<div class="ptmp-flash"></div>' +
			'<div class="ptmp-panel"><div class="ptmp-head"><span class="ptmp-title"></span><span class="ptmp-tag"></span></div><div class="ptmp-body"></div></div>' +
			'<div class="ptmp-countdown" style="display:none"></div>' +
			'<div class="ptmp-clock" style="display:none"></div>' +
			'<div class="ptmp-item" style="display:none"><div class="icon"></div><div class="label"></div></div>';
		document.body.appendChild(root);
		const ui = {
			root,
			panel: root.querySelector(".ptmp-panel"),
			title: root.querySelector(".ptmp-title"),
			tag: root.querySelector(".ptmp-tag"),
			body: root.querySelector(".ptmp-body"),
			countdown: root.querySelector(".ptmp-countdown"),
			clock: root.querySelector(".ptmp-clock"),
			item: root.querySelector(".ptmp-item"),
			flash: root.querySelector(".ptmp-flash"),
			toasts: []
		};
		root.querySelector(".ptmp-head").addEventListener("click", () => ui.panel.classList.toggle("collapsed"));
		ui.item.addEventListener("click", () => useItem());
		S.ui = ui;
	}

	function hideUI() {
		if (S.ui != null) S.ui.root.style.display = "none";
	}

	function toast(text, ms = 1800, big = false) {
		if (S.ui == null) return;
		for (const t of S.ui.toasts) t.remove();
		const el = document.createElement("div");
		el.className = "ptmp-toast" + (big ? " big" : "");
		el.textContent = text;
		S.ui.root.appendChild(el);
		S.ui.toasts = [el];
		setTimeout(() => (el.style.opacity = "0"), ms);
		setTimeout(() => el.remove(), ms + 400);
	}

	function flash(color) {
		if (S.ui == null) return;
		const f = S.ui.flash;
		f.style.transition = "none";
		f.style.background = `radial-gradient(ellipse at center, transparent 40%, ${color} 140%)`;
		f.style.opacity = "0.9";
		requestAnimationFrame(() => {
			f.style.transition = "opacity 0.6s";
			f.style.opacity = "0";
		});
	}

	function button(label, onClick, disabled = false) {
		const b = document.createElement("button");
		b.className = "ptmp-btn";
		b.textContent = label;
		b.disabled = disabled;
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			onClick();
		});
		return b;
	}

	function li(left, right, cls = "") {
		const el = document.createElement("li");
		if (cls) el.className = cls;
		const a = document.createElement("span");
		a.textContent = left;
		const b = document.createElement("span");
		b.textContent = right;
		el.append(a, b);
		return el;
	}

	function renderPanel() {
		const ui = S.ui;
		if (ui == null || S.ps == null) return;
		const me = selfId();
		const mode = MODES[S.mode] ?? MODES.ghost;
		ui.panel.style.setProperty("--ptmp-accent", S.mode === "race" ? "#ff5b8a" : S.mode === "tour" ? "#ffd23c" : "#5ee1ff");
		ui.title.textContent = mode.name;
		ui.tag.textContent = S.powerups ? "Power-ups ON" : "No power-ups";
		const body = ui.body;
		body.innerHTML = "";
		const status = document.createElement("div");
		status.className = "ptmp-status";
		body.appendChild(status);
		const hint = (text) => {
			const h = document.createElement("div");
			h.className = "ptmp-hint";
			h.textContent = text;
			body.appendChild(h);
		};

		if (S.mode === "ghost") {
			status.textContent = "Set your best time — other cars are ghosts.";
			if (S.powerups) hint("Drive through checkpoints to get a power-up, press E to use it.");
		} else if (S.mode === "race") {
			const race = S.race;
			const res = S.results;
			if (race == null || race.state === "done") {
				status.textContent = S.isHost ? "Press Start Race when everyone is here." : "Waiting for the host to start the race…";
			} else if (race.state === "countdown") {
				status.textContent = amRacer() ? "Get ready!" : "Race starting…";
			} else if (race.state === "racing") {
				status.textContent = amRacer() ? (race.finished ? "Finished — waiting for others" : "Race on! Crash = restart from the grid.") : "Race in progress — you're spectating.";
			} else {
				status.textContent = "Race in progress — you joined late and are spectating.";
			}
			if (res != null && res.session === S.sessionId) {
				const t = document.createElement("div");
				t.className = "ptmp-status";
				t.textContent = res.final ? "Final results" : "Standings";
				body.appendChild(t);
				const ul = document.createElement("ul");
				ul.className = "ptmp-list";
				res.list.forEach((r, i) => ul.appendChild(li(`${r.ms != null ? i + 1 + "." : "–"} ${r.name}`, r.ms != null ? fmtTime(r.ms) : r.done ? "DNF" : "racing…", r.id === me ? "me" : "")));
				body.appendChild(ul);
			} else if (race != null && race.state !== "done") {
				const ul = document.createElement("ul");
				ul.className = "ptmp-list";
				for (const id of race.racers) ul.appendChild(li(nameOf(id), "racing", id === me ? "me" : ""));
				body.appendChild(ul);
			}
			if (S.isHost) {
				const busy = race != null && (race.state === "countdown" || race.state === "racing");
				const n = players().length;
				body.appendChild(button(res?.final ? "Rematch" : "Start Race", () => hostStartRace("race", players().map((p) => p.id).slice(0, 5), null), busy || n < 1));
				if (busy) body.appendChild(button("End Race Now", () => hostEndRace()));
				hint("Up to 5 racers. Use Change Track (top left) to pick another track.");
			}
			if (S.powerups) hint("Checkpoints give power-ups — press E to use.");
		} else if (S.mode === "tour") {
			const T = S.tour;
			if (T == null || T.round === 0 && T.state !== "between") {
				status.textContent = S.isHost ? `${players().length} player(s) here. Start when everyone has joined (max 8).` : "Waiting for the host to start the tournament…";
				const ul = document.createElement("ul");
				ul.className = "ptmp-list";
				for (const p of players()) ul.appendChild(li(p.nickname, p.isSelf ? "you" : "", p.isSelf ? "me" : ""));
				body.appendChild(ul);
				if (S.isHost) body.appendChild(button("Start Tournament", () => hostStartTournament(), players().length < 2));
			} else {
				const names = T.names || {};
				const nm = (id) => (id == null ? "—" : names[id] ?? nameOf(id));
				if (T.state === "done") {
					status.textContent = T.champion != null ? `🏆 ${nm(T.champion)} wins the tournament!` : "Tournament over.";
				} else if (T.state === "loading") {
					status.textContent = `Round ${T.round} — loading ${T.trackName ?? "track"}…`;
				} else if (T.state === "racing") {
					const opp = S.race?.opp?.[me];
					status.textContent = opp != null ? `Round ${T.round} on ${T.trackName}: you vs ${nm(opp)}` : T.alive.includes(me) ? `Round ${T.round}: you have a bye — free practice.` : `Round ${T.round} on ${T.trackName} — spectating.`;
				} else if (T.state === "between") {
					status.textContent = T.round === 0 ? "Drawing the bracket…" : T.alive.length > 1 ? `Round ${T.round} done. Next round soon…` : "Final finished!";
				}
				const title = document.createElement("div");
				title.className = "ptmp-status";
				title.textContent = T.round > 0 ? `Round ${T.round} matches` : "";
				body.appendChild(title);
				for (const m of T.matches || []) {
					const row = document.createElement("div");
					row.className = "ptmp-match";
					const span = (id) => {
						const s = document.createElement("span");
						s.textContent = nm(id);
						if (m.winner != null && m.winner !== -1) s.className = m.winner === id ? "w" : "l";
						if (id === me) s.style.textDecorationColor = "#ff5";
						return s;
					};
					if (m.b == null) {
						row.append(span(m.a), document.createTextNode(" — bye"));
					} else {
						row.append(span(m.a), document.createTextNode(" vs "), span(m.b));
						if (m.times && (m.times[m.a] != null || m.times[m.b] != null)) {
							const t = document.createElement("div");
							t.className = "ptmp-hint";
							t.textContent = `${fmtTime(m.times[m.a])} / ${fmtTime(m.times[m.b])}` + (m.decidedBy && m.decidedBy !== "race" ? ` (${m.decidedBy})` : "");
							row.appendChild(t);
						} else if (m.decidedBy && m.decidedBy !== "race") {
							const t = document.createElement("div");
							t.className = "ptmp-hint";
							t.textContent = m.decidedBy;
							row.appendChild(t);
						}
					}
					body.appendChild(row);
				}
				if (T.state !== "done" && T.alive) hint(`Still in: ${T.alive.map(nm).join(", ")}`);
				if (S.isHost && T.state === "done") body.appendChild(button("New Tournament", () => hostStartTournament(), players().length < 2));
			}
			if (S.powerups) hint("Checkpoints give power-ups — press E to use.");
		}
		renderItem();
	}

	function renderItem() {
		const ui = S.ui;
		if (ui == null) return;
		const show = S.ps != null && S.powerups;
		ui.item.style.display = show ? "" : "none";
		if (!show) return;
		const icon = ui.item.querySelector(".icon");
		const label = ui.item.querySelector(".label");
		if (S.rollUntil > 0) {
			const keys = Object.keys(ITEMS);
			const k = keys[Math.floor(performance.now() / 90) % keys.length];
			ui.item.classList.add("rolling");
			icon.textContent = ITEMS[k].icon;
			icon.style.color = ITEMS[k].color;
			label.textContent = "…";
		} else {
			ui.item.classList.remove("rolling");
			const it = S.item != null ? ITEMS[S.item] : null;
			icon.textContent = it ? it.icon : "?";
			icon.style.color = it ? it.color : "rgba(255,255,255,0.3)";
			label.textContent = it ? it.name + " [E]" : "Empty";
			ui.item.style.borderColor = it ? it.color : "";
		}
	}

	function renderClock(now) {
		const ui = S.ui;
		if (ui == null) return;
		const race = S.race;
		if (race != null && race.state === "countdown" && isRaceMode()) {
			const left = Math.ceil((race.goAt - now) / 1000);
			ui.countdown.style.display = "";
			ui.countdown.textContent = left > 0 ? String(left) : "";
		} else {
			ui.countdown.style.display = "none";
		}
		if (race != null && race.state === "racing" && isRaceMode() && amRacer()) {
			ui.clock.style.display = "";
			ui.clock.textContent = "Race " + fmtTime(race.finished ? race.myTime : now - race.startAt);
		} else {
			ui.clock.style.display = "none";
		}
	}

	// Extra options in the "Host Multiplayer Game" box.
	function hostOptionsUI(mainBox, slider, sliderLabel, gameModeContainer) {
		const box = document.createElement("div");
		box.className = "ptmp ptmp-host-opts";
		const modeTitle = document.createElement("div");
		modeTitle.className = "title";
		modeTitle.textContent = "Multiplayer Mode";
		const modeRow = document.createElement("div");
		modeRow.className = "row";
		const puTitle = document.createElement("div");
		puTitle.className = "title";
		puTitle.textContent = "Power-ups";
		const puRow = document.createElement("div");
		puRow.className = "row";
		const info = document.createElement("div");
		info.className = "info";
		box.append(modeTitle, modeRow, puTitle, puRow, info);
		mainBox.insertBefore(box, gameModeContainer);

		const refresh = () => {
			const m = MODES[S.pendingHostMode];
			for (const b of modeRow.children) b.classList.toggle("selected", b.dataset.mode === S.pendingHostMode);
			for (const b of puRow.children) b.classList.toggle("selected", (b.dataset.on === "1") === S.pendingHostPowerups);
			info.textContent = m.desc + (S.pendingHostPowerups ? " Power-ups: drive through checkpoints to get Nitro, Super Grip" + (S.pendingHostMode === "ghost" ? "" : " or Shockwave") + " (use with E). Times aren't saved as records." : "");
			gameModeContainer.style.display = S.pendingHostMode === "ghost" ? "" : "none";
			slider.max = String(m.maxPlayers);
			if (parseInt(slider.value) > m.maxPlayers || S._lastMax !== m.maxPlayers) slider.value = String(m.maxPlayers);
			S._lastMax = m.maxPlayers;
			slider.dispatchEvent(new Event("input"));
		};
		for (const key of Object.keys(MODES)) {
			const b = document.createElement("button");
			b.className = "button";
			b.dataset.mode = key;
			b.textContent = MODES[key].name;
			b.addEventListener("click", () => {
				S.pendingHostMode = key;
				refresh();
			});
			modeRow.appendChild(b);
		}
		for (const [label, on] of [["Off", false], ["On", true]]) {
			const b = document.createElement("button");
			b.className = "button";
			b.dataset.on = on ? "1" : "0";
			b.textContent = label;
			b.addEventListener("click", () => {
				S.pendingHostPowerups = on;
				refresh();
			});
			puRow.appendChild(b);
		}
		S._lastMax = null;
		refresh();
	}

	return {
		serverUrl,
		officialTracks: null,
		// hooks
		onCustom,
		onWorkerMessage,
		engineGameMode,
		onHostCreated,
		onPlayState,
		onPlayStateDispose,
		localStart,
		onLocalCar,
		wantStart,
		noCheckpointReset,
		blockRecords,
		flushMs,
		renderDelay,
		opacity,
		update,
		hostOptionsUI,
		// for debugging / tests
		_state: S,
		_useItem: useItem,
		_hostStartRace: () => hostStartRace("race", players().map((p) => p.id).slice(0, 5), null),
		_hostStartTournament: () => hostStartTournament(),
		_hostStartRaceWith: (kind, racers, opp) => hostStartRace(kind, racers, opp),
		// Test hook: report a finish time as if the local car had crossed the line.
		_debugFinish: (ms) => {
			if (S.race == null || S.race.finished || !amRacer()) return false;
			S.race.finished = true;
			S.race.myTime = ms;
			send({ t: "finish", id: S.race.id, ms });
			renderPanel();
			return true;
		}
	};
})();
