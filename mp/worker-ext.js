// PolyTrack multiplayer add-on: physics worker extension.
//
// The physics engine is a compiled WebAssembly module (Bullet) that simulates each car alone in
// its own world. It has no API for car-to-car contact or for power-ups, so this file adds them
// from the outside: it finds the car's rigid body in the engine's memory and adjusts its
// velocity between simulation steps.
//
// Nothing here runs for a car unless the main thread has sent that car a multiplayer message
// (race mode / power-ups), so normal solo runs and leaderboard replays are simulated exactly as
// in the unmodified game.

"use strict";

self.PTW = (function () {
	const MSG_TYPE = 100; // custom message id, outside the game's own 0..10 range
	const DT = 0.001; // the engine runs at 1000 steps per second

	// Offsets inside Bullet's btRigidBody (32-bit build used by the game).
	const OFF_ORIGIN = 52;
	const OFF_INTERP_ORIGIN = 116;
	const OFF_LINEAR_VELOCITY = 312;
	const OFF_ANGULAR_VELOCITY = 328;

	// Car box used for car-to-car contact (chassis plus wheels), in car-local coordinates.
	const BOX_HALF = [1.05, 0.5, 1.85];
	const BOX_CENTER = [0, 0.05, -0.15];
	const RESTITUTION = 0.35; // bounciness of car-to-car hits
	const SEPARATION_DV = 4; // m/s extra push so overlapping cars come apart
	const CONTACT_PUSH = 35; // m/s^2 steady push while two cars keep overlapping
	const MAX_PUSH_DV = 12; // m/s of steady push available at once (players' views can disagree)
	const PUSH_REFILL = 25; // m/s^2: how fast that push budget comes back during a long shove
	const MAX_SPIN = 2.5; // rad/s of yaw one contact can add
	const CAR_YAW_INERTIA_FACTOR = 0.25; // 1 / (inertia / mass), tuned for a believable spin

	let M = null;
	let cars = null;
	/** carId -> per-car extension state */
	const ext = new Map();

	function attach(module, carList) {
		M = module;
		cars = carList;
	}

	function getExt(carId) {
		let x = ext.get(carId);
		if (x == null) {
			x = {
				base: 0,
				nextScanFrame: 0,
				steps: 0,
				pos: null,
				quat: null,
				contacts: 0,
				impulses: [],
				boostFrames: 0,
				boostAccel: 0,
				gripFrames: 0,
				gripStrength: 0,
				collide: false,
				others: [],
				othersAge: 0,
				hits: []
			};
			ext.set(carId, x);
		}
		return x;
	}

	// --- messages from the main thread ---------------------------------------------------------

	function onMessage(message) {
		if (message == null || message.messageType !== MSG_TYPE) {
			if (message != null && message.messageType === 4 /* DeleteCar */) ext.delete(message.carId);
			return false;
		}
		const x = getExt(message.carId);
		switch (message.op) {
			case "track":
				break;
			case "impulse":
				x.impulses.push({ dv: message.dv || [0, 0, 0], dw: message.dw || [0, 0, 0] });
				break;
			case "boost":
				x.boostFrames = Math.max(0, message.frames | 0);
				x.boostAccel = +message.accel || 0;
				break;
			case "grip":
				x.gripFrames = Math.max(0, message.frames | 0);
				x.gripStrength = +message.strength || 0;
				break;
			case "collide":
				x.collide = !!message.enabled;
				if (!x.collide) x.others.length = 0;
				break;
			case "others": {
				// Latest known pose/velocity of the other cars this car can bump into.
				const previous = new Map(x.others.map((o) => [o.id, o]));
				x.others = (message.cars || []).map((c) => {
					const old = previous.get(c.id);
					return {
						id: c.id,
						p: c.p,
						q: c.q,
						v: c.v,
						// A pair only becomes solid after the two cars have been apart once, so cars
						// that spawn on top of each other don't explode.
						armed: old != null ? old.armed && !c.respawned : false,
						cooldown: old != null ? old.cooldown : 0,
						acc: old != null ? old.acc : 0,
						budget: old != null ? old.budget : 0,
						pushAcc: old != null ? old.pushAcc : 0,
						spinAcc: old != null ? old.spinAcc : 0
					};
				});
				x.othersAge = 0;
				break;
			}
			case "clear":
				x.impulses.length = 0;
				x.boostFrames = 0;
				x.gripFrames = 0;
				break;
		}
		return true;
	}

	// --- start grid ------------------------------------------------------------------------------

	function adjustStart(message, start) {
		const s = message.ptStart;
		if (s == null || start == null) return start;
		return { position: { x: s.x, y: s.y, z: s.z }, quaternion: start.quaternion };
	}

	// --- rigid body lookup -----------------------------------------------------------------------

	function bodyMatches(F, base, pos) {
		const i = (base + OFF_ORIGIN) >> 2;
		return F[i] === pos[0] && F[i + 1] === pos[1] && F[i + 2] === pos[2];
	}

	function locate(x) {
		if (x.pos == null) return 0;
		const F = M.HEAPF32;
		if (x.base !== 0 && bodyMatches(F, x.base, x.pos)) return x.base;
		x.base = 0;
		if (x.steps < x.nextScanFrame) return 0;
		x.nextScanFrame = x.steps + 100;

		const px = x.pos[0];
		const py = x.pos[1];
		const pz = x.pos[2];
		const gap = (OFF_INTERP_ORIGIN - OFF_ORIGIN) >> 2;
		const first = OFF_ORIGIN >> 2;
		const last = F.length - gap - 3;
		let found = 0;
		let count = 0;
		for (let i = first; i < last; i++) {
			if (F[i] === px && F[i + 1] === py && F[i + 2] === pz && F[i + gap] === px && F[i + gap + 1] === py && F[i + gap + 2] === pz) {
				found = i * 4 - OFF_ORIGIN;
				count++;
			}
		}
		// More than one match means another car sits at exactly the same spot (e.g. on the start
		// line); wait until they have moved apart rather than risk touching the wrong body.
		if (count !== 1) return 0;
		x.base = found;
		return found;
	}

	// --- small vector helpers --------------------------------------------------------------------

	function rotate(q, v) {
		const x = q[0], y = q[1], z = q[2], w = q[3];
		const ix = w * v[0] + y * v[2] - z * v[1];
		const iy = w * v[1] + z * v[0] - x * v[2];
		const iz = w * v[2] + x * v[1] - y * v[0];
		const iw = -x * v[0] - y * v[1] - z * v[2];
		return [
			ix * w + iw * -x + iy * -z - iz * -y,
			iy * w + iw * -y + iz * -x - ix * -z,
			iz * w + iw * -z + ix * -y - iy * -x
		];
	}

	const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

	function boxOf(p, q) {
		const axes = [rotate(q, [1, 0, 0]), rotate(q, [0, 1, 0]), rotate(q, [0, 0, 1])];
		const c = [
			p[0] + axes[0][0] * BOX_CENTER[0] + axes[1][0] * BOX_CENTER[1] + axes[2][0] * BOX_CENTER[2],
			p[1] + axes[0][1] * BOX_CENTER[0] + axes[1][1] * BOX_CENTER[1] + axes[2][1] * BOX_CENTER[2],
			p[2] + axes[0][2] * BOX_CENTER[0] + axes[1][2] * BOX_CENTER[1] + axes[2][2] * BOX_CENTER[2]
		];
		return { c, axes };
	}

	/**
	 * Separating-axis test between two car boxes.
	 * Returns null when apart, otherwise { n, depth } where n points from B towards A.
	 */
	function overlap(a, b) {
		const d = [a.c[0] - b.c[0], a.c[1] - b.c[1], a.c[2] - b.c[2]];
		let bestDepth = Infinity;
		let bestAxis = null;
		const test = (axis) => {
			const len = Math.hypot(axis[0], axis[1], axis[2]);
			if (len < 1e-6) return true;
			const n = [axis[0] / len, axis[1] / len, axis[2] / len];
			let ra = 0;
			let rb = 0;
			for (let i = 0; i < 3; i++) {
				ra += BOX_HALF[i] * Math.abs(dot(a.axes[i], n));
				rb += BOX_HALF[i] * Math.abs(dot(b.axes[i], n));
			}
			const dist = dot(d, n);
			const depth = ra + rb - Math.abs(dist);
			if (depth <= 0) return false;
			if (depth < bestDepth) {
				bestDepth = depth;
				bestAxis = dist >= 0 ? n : [-n[0], -n[1], -n[2]];
			}
			return true;
		};
		for (let i = 0; i < 3; i++) if (!test(a.axes[i])) return null;
		for (let i = 0; i < 3; i++) if (!test(b.axes[i])) return null;
		for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (!test(cross(a.axes[i], b.axes[j]))) return null;
		return bestAxis == null ? null : { n: bestAxis, depth: bestDepth };
	}

	// --- per-step hooks --------------------------------------------------------------------------

	/** Called right before the engine advances `car` by one step. */
	function preStep(car) {
		const x = ext.get(car.id);
		if (x == null) return;
		const active = x.impulses.length > 0 || x.boostFrames > 0 || x.gripFrames > 0 || (x.collide && x.others.length > 0);
		if (!active) return;
		const base = locate(x);
		if (base === 0) {
			// Don't let one-shot effects pile up while the body can't be found.
			if (x.impulses.length > 8) x.impulses.length = 0;
			return;
		}
		const F = M.HEAPF32;
		const lv = (base + OFF_LINEAR_VELOCITY) >> 2;
		const av = (base + OFF_ANGULAR_VELOCITY) >> 2;
		let vx = F[lv], vy = F[lv + 1], vz = F[lv + 2];
		let wx = F[av], wy = F[av + 1], wz = F[av + 2];

		// Car axes from the car's reported orientation (the physics body itself is modelled facing
		// the other way, so its own basis can't be used for "forward").
		const q = x.quat ?? [0, 0, 0, 1];
		const right = rotate(q, [1, 0, 0]);
		const up = rotate(q, [0, 1, 0]);
		const fwd = rotate(q, [0, 0, 1]);

		for (const imp of x.impulses) {
			vx += imp.dv[0]; vy += imp.dv[1]; vz += imp.dv[2];
			wx += imp.dw[0]; wy += imp.dw[1]; wz += imp.dw[2];
		}
		x.impulses.length = 0;

		if (x.boostFrames > 0) {
			x.boostFrames--;
			const a = x.boostAccel * DT;
			vx += fwd[0] * a; vy += fwd[1] * a; vz += fwd[2] * a;
		}

		if (x.gripFrames > 0) {
			x.gripFrames--;
			if (x.contacts >= 2) {
				// Kill sideways sliding and press the car into the road.
				const lateral = vx * right[0] + vy * right[1] + vz * right[2];
				const k = lateral * x.gripStrength;
				vx -= right[0] * k; vy -= right[1] * k; vz -= right[2] * k;
				const down = 18 * DT;
				vx -= up[0] * down; vy -= up[1] * down; vz -= up[2] * down;
			}
		}

		if (x.collide && x.others.length > 0 && x.quat != null) {
			x.othersAge += DT;
			// Stop trusting stale data (e.g. the tab that feeds us went to the background).
			if (x.othersAge < 0.5) {
				const self = boxOf(x.pos, x.quat);
				const speedBefore = Math.hypot(vx, vy, vz);
				let touched = false;
				let fastestOther = 0;
				for (const o of x.others) {
					if (o.cooldown > 0) o.cooldown--;
					o.pushAcc = Math.max(0, o.pushAcc - PUSH_REFILL * DT);
					const t = x.othersAge;
					const op = [o.p[0] + o.v[0] * t, o.p[1] + o.v[1] * t, o.p[2] + o.v[2] * t];
					const dx = op[0] - x.pos[0], dy = op[1] - x.pos[1], dz = op[2] - x.pos[2];
					if (dx * dx + dy * dy + dz * dz > 36) {
						o.armed = true;
						o.acc = 0;
						o.pushAcc = 0;
						o.spinAcc = 0;
						continue;
					}
					const hit = overlap(self, boxOf(op, o.q));
					if (hit == null) {
						o.armed = true;
						o.acc = 0;
						o.pushAcc = 0;
						o.spinAcc = 0;
						continue;
					}
					if (!o.armed) continue;
					const n = hit.n;
					const rel = [vx - o.v[0], vy - o.v[1], vz - o.v[2]];
					const vn = dot(rel, n);
					// Bounce if closing in, and always keep at least a small separating speed while
					// the boxes still overlap so cars can't sink into each other.
					const wanted = Math.max(vn < 0 ? -RESTITUTION * vn : vn, Math.min(hit.depth * 10, 4));
					if (wanted <= vn) continue;
					// Each player's own game applies its half of the exchange. One contact can change
					// this car's speed by at most its share of a real bounce plus a small push apart, so
					// stale network data can't launch anyone.
					if (o.acc === 0) o.budget = 0.5 * (1 + RESTITUTION) * Math.max(0, -vn) + SEPARATION_DV;
					const impulse = Math.min((wanted - vn) * 0.5, Math.max(0, o.budget - o.acc));
					o.acc += Math.max(0, impulse);
					// Once the bounce is spent, cars that keep overlapping are pushed apart by a steady,
					// limited force (so a car on full throttle can't drive through another one).
					let push = 0;
					if (impulse < (wanted - vn) * 0.5 && o.pushAcc < MAX_PUSH_DV) {
						push = Math.min((wanted - vn) * 0.5 - Math.max(0, impulse), CONTACT_PUSH * DT, MAX_PUSH_DV - o.pushAcc);
						o.pushAcc += push;
					}
					const dvn = Math.max(0, impulse) + push;
					if (dvn <= 0) continue;
					touched = true;
					fastestOther = Math.max(fastestOther, Math.hypot(o.v[0], o.v[1], o.v[2]));
					const dv = [n[0] * dvn, n[1] * dvn, n[2] * dvn];
					vx += dv[0]; vy += dv[1]; vz += dv[2];
					// Off-centre hits spin the car (yaw only, to keep things controllable).
					const cp = [(self.c[0] + op[0]) * 0.5 - x.pos[0], 0, (self.c[2] + op[2]) * 0.5 - x.pos[2]];
					const spin = cross(cp, dv)[1] * CAR_YAW_INERTIA_FACTOR;
					const spinRoom = Math.max(0, MAX_SPIN - o.spinAcc);
					const appliedSpin = Math.max(-spinRoom, Math.min(spinRoom, spin));
					o.spinAcc += Math.abs(appliedSpin);
					wy += appliedSpin;
					if (o.cooldown === 0 && vn < -1.5) {
						x.hits.push({ id: o.id, speed: -vn });
						o.cooldown = 300;
					}
				}
				// A bump may slow you down or shove you sideways, but never make you faster than
				// the faster of the two cars is going.
				if (touched) {
					const limit = Math.max(speedBefore, fastestOther);
					const speedAfter = Math.hypot(vx, vy, vz);
					if (speedAfter > limit) {
						const k = limit / speedAfter;
						vx *= k; vy *= k; vz *= k;
					}
				}
			}
		}

		F[lv] = vx; F[lv + 1] = vy; F[lv + 2] = vz;
		F[av] = wx; F[av + 1] = wy; F[av + 2] = wz;
	}

	/** Called right after the engine has written the car's new state to `statePtr`. */
	function postStep(car, statePtr) {
		const x = ext.get(car.id);
		if (x == null) return;
		x.steps++;
		const U = M.HEAPU8;
		// State layout: carId(4) frames(3) speed(4) flags(1) [finishFrames(3)] checkpoint(2) pos(12) quat(16)
		const flags = U[statePtr + 11];
		let o = statePtr + 12;
		if (flags & 2) o += 3;
		o += 2;
		const view = new DataView(U.buffer, o, 28);
		x.pos = [view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true)];
		x.quat = [view.getFloat32(12, true), view.getFloat32(16, true), view.getFloat32(20, true), view.getFloat32(24, true)];
		x.contacts = ((flags >> 3) & 1) + ((flags >> 4) & 1) + ((flags >> 5) & 1) + ((flags >> 6) & 1);
		if (x.hits.length > 0) {
			self.postMessage({ messageType: MSG_TYPE, carId: car.id, hits: x.hits });
			x.hits = [];
		}
	}

	return { attach, onMessage, adjustStart, preStep, postStep, _ext: ext, _overlap: overlap, _boxOf: boxOf };
})();
