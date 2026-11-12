"use strict";

// Exact-text patches for simulation_worker.bundle.js. See patch-bundles.js.
// All added behaviour lives in mp/worker-ext.js (the PTW object).
module.exports = [
	{
		name: "load the worker extension",
		find: 'importScripts("lib/polytrack_physics.js");',
		replace: 'importScripts("lib/polytrack_physics.js","mp/worker-ext.js");'
	},
	{
		name: "hand the physics module to the extension and let it see messages first",
		find: "const e=[];function i(i){const s=i.data;switch(s.messageType){",
		replace: "const e=[];PTW.attach(t,e);function i(i){const s=i.data;if(PTW.onMessage(s))return;switch(s.messageType){"
	},
	{
		name: "start grid position for race cars",
		find: 'const o=i.getStartTransform();if(null==o)throw new Error("Track has no starting point");const l=t.carId;',
		replace: 'const o=PTW.adjustStart(t,i.getStartTransform());if(null==o)throw new Error("Track has no starting point");const l=t.carId;'
	},
	{
		name: "per-step hooks (collisions, boost, grip)",
		find: 'function a(e,i){t.ccall("updateCarModel","void",["number","boolean","boolean","boolean","boolean","boolean","number"],[e.id,i.up,i.right,i.down,i.left,i.reset,n]);return',
		replace: 'function a(e,i){PTW.preStep(e);t.ccall("updateCarModel","void",["number","boolean","boolean","boolean","boolean","boolean","number"],[e.id,i.up,i.right,i.down,i.left,i.reset,n]);PTW.postStep(e,n);return'
	}
];
