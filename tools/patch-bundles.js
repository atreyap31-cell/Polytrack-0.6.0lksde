// Applies the multiplayer patches to the game's compiled bundles.
//
// The game ships as minified webpack bundles (no source), so the multiplayer add-on works by
// making a handful of small, exact text replacements that call into mp/multiplayer.js (main
// thread) and mp/worker-ext.js (physics worker). All real logic lives in those two files.
//
// Usage:  node tools/patch-bundles.js
// The script always starts from the pristine bundles stored in git (PRISTINE_COMMIT), so it is
// safe to run repeatedly.

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PRISTINE_COMMIT = "d6333d4";

function pristine(file) {
	return execFileSync("git", ["show", `${PRISTINE_COMMIT}:${file}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
}

function applyPatches(file, patches) {
	let source = pristine(file);
	for (const patch of patches) {
		const count = source.split(patch.find).length - 1;
		const expected = patch.count ?? 1;
		if (count !== expected) {
			throw new Error(`${file}: patch "${patch.name}" expected ${expected} match(es) but found ${count}`);
		}
		source = source.split(patch.find).join(patch.replace);
	}
	fs.writeFileSync(path.join(ROOT, file), source);
	console.log(`${file}: applied ${patches.length} patches`);
}

module.exports = { applyPatches };

if (require.main === module) {
	applyPatches("main.bundle.js", require("./patches-main.js"));
	applyPatches("simulation_worker.bundle.js", require("./patches-worker.js"));
}
