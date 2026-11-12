"use strict";

// Exact-text patches for main.bundle.js. See patch-bundles.js.
// Every patch only adds a call into window.PTMP (mp/multiplayer.js); the logic lives there.
const G = '(0,C.gn)';

module.exports = [
	// --- matchmaking server ---------------------------------------------------------------------
	{
		name: "host matchmaking socket -> our server",
		find: 'createMultiplayerHostWebSocket(){if(this.determinismState!=Js.Ok)throw new Error("WebSocket creation not allowed with non-deterministic physics");return new WebSocket("https://vps.kodub.com/"+(0,C.gn)(this,ku,"f")+"multiplayer/host")}',
		replace: 'createMultiplayerHostWebSocket(){return new WebSocket(PTMP.serverUrl("ws","multiplayer/host"))}'
	},
	{
		name: "join matchmaking socket -> our server",
		find: 'createMultiplayerJoinWebSocket(){if(this.determinismState!=Js.Ok)throw new Error("WebSocket creation not allowed with non-deterministic physics");return new WebSocket("https://vps.kodub.com/"+(0,C.gn)(this,ku,"f")+"multiplayer/join")}',
		replace: 'createMultiplayerJoinWebSocket(){return new WebSocket(PTMP.serverUrl("ws","multiplayer/join"))}'
	},
	{
		name: "ice servers -> our server",
		find: 'const n="https://vps.kodub.com/"+(0,C.gn)(this,ku,"f")+"iceServers?version=0.6.0",i=new XMLHttpRequest;',
		replace: 'const n=PTMP.serverUrl("http","iceServers"),i=new XMLHttpRequest;'
	},
	{
		name: "expose the official track list (tournament picks random tracks from it)",
		find: '.then((e=>{(0,C.GG)(this,Jh,e,"f")}))',
		replace: '.then((e=>{(0,C.GG)(this,Jh,e,"f"),PTMP.officialTracks=e}))'
	},

	// --- custom messages over the game's data channels ------------------------------------------
	{
		name: "host connection: send helpers",
		find: "kickPlayer(e){",
		replace: `ptSend(e,t){for(const n of ${G}(this,mn,"f"))if(null==e||n.id==e)try{n.dataChannel.send(t)}catch(e){console.error(e)}}ptSelfId(){return ${G}(this,fn,"f").id}kickPlayer(e){`
	},
	{
		name: "client connection: send helpers",
		find: "async joinInvite(e,t){",
		replace: `ptSend(e,t){try{${G}(this,ml,"f")?.send(t)}catch(e){console.error(e)}}ptSelfId(){return ${G}(this,_l,"f").id}async joinInvite(e,t){`
	},
	{
		name: "host connection: receive custom messages",
		find: "case qt.ModCustomMessage:break;",
		replace: "case qt.ModCustomMessage:PTMP.onCustom(this,t.id,i),r=i.length;break;"
	},
	{
		name: "client connection: receive custom messages",
		find: "case Jt.ModCustomMessage:break;",
		replace: "case Jt.ModCustomMessage:PTMP.onCustom(this,null,i),r=i.length;break;"
	},
	{
		name: "host relays car positions faster in race modes",
		find: `setInterval((()=>{${G}(this,en,"m",zn).call(this)}),100)`,
		replace: `setInterval((()=>{${G}(this,en,"m",zn).call(this)}),PTMP.flushMs())`
	},

	// --- host menu ------------------------------------------------------------------------------
	{
		name: "host menu: mode + power-up options",
		find: "h.appendChild(u);let p=null;",
		replace: "h.appendChild(u),PTMP.hostOptionsUI(t,u,d,a);let p=null;"
	},
	{
		name: "host menu: create game with the chosen mode",
		find: `const i=new Fn(${G}(this,Fl,"f"),${G}(this,Vl,"f"),n,${G}(this,Hl,"f")),a=i.startNewSessionImmediate(r,e,t);`,
		replace: `r=PTMP.engineGameMode(r);const i=new Fn(${G}(this,Fl,"f"),${G}(this,Vl,"f"),n,${G}(this,Hl,"f")),a=(PTMP.onHostCreated(i),i.startNewSessionImmediate(r,e,t));`
	},

	// --- play state -----------------------------------------------------------------------------
	{
		name: "play state created",
		find: `const I=${G}(this,Gr,"f").getSettingBoolean(R.A.DefaultCameraMode);`,
		replace: `PTMP.onPlayState(this,${G}(this,Sa,"f"),(()=>${G}(this,_r,"m",Qa).call(this)));const I=${G}(this,Gr,"f").getSettingBoolean(R.A.DefaultCameraMode);`
	},
	{
		name: "play state accessors",
		find: `get multiplayerConnection(){return${G}(this,Sa,"f")?.multiplayerConnection??null}`,
		replace: `ptRemote(){return${G}(this,Ra,"f")}get multiplayerConnection(){return${G}(this,Sa,"f")?.multiplayerConnection??null}`
	},
	{
		name: "play state disposed",
		find: `dispose(e=!0,t=!0){null!=${G}(this,Sa,"f")&&`,
		replace: `dispose(e=!0,t=!0){PTMP.onPlayStateDispose(this);null!=${G}(this,Sa,"f")&&`
	},
	{
		name: "play state per-frame update",
		find: "update(e){const t=!P.ip()&&",
		replace: "update(e){PTMP.update(this,e);const t=!P.ip()&&"
	},
	{
		name: "starting grid for the local car",
		find: `const i=${G}(this,Pr,"f").getStartTransform();if(null==i)throw new Error("Start transform is null");const r=(0,C.GG)(this,Ia,`,
		replace: `const i=PTMP.localStart(${G}(this,Pr,"f").getStartTransform());if(null==i)throw new Error("Start transform is null");const r=(0,C.GG)(this,Ia,`
	},
	{
		name: "local car created",
		find: "return s.notificationAudioEnabled=!0,",
		replace: "return PTMP.onLocalCar(s),s.notificationAudioEnabled=!0,"
	},
	{
		name: "countdown: cars can't start early, and start automatically at GO",
		find: `(e.up||e.down)&&(${G}(this,wa,"f").hasStarted()||${G}(this,wa,"f").start())`,
		replace: `PTMP.wantStart(e.up||e.down)&&(${G}(this,wa,"f").hasStarted()||${G}(this,wa,"f").start())`
	},
	{
		name: "race mode: reset means restart (no checkpoint respawn)",
		find: "ja=function(){return!(",
		replace: "ja=function(){return!PTMP.noCheckpointReset()&&!("
	},
	{
		name: "don't save records from races / power-up runs",
		find: `if(a=(async()=>{if(${G}(this,jr,"f")){`,
		replace: `if(a=(async()=>{if(${G}(this,jr,"f")&&!PTMP.blockRecords()){`
	},
	{
		name: "don't replay own ghost when runs used power-ups / grid starts",
		find: `if(null!=e)if(0==${G}(this,xa,"f").length)`,
		replace: `if(null!=e&&!PTMP.blockRecords())if(0==${G}(this,xa,"f").length)`
	},
	{
		name: "ghost / solid opacity of other cars",
		find: "i=Math.max(0,Math.min(1,t/5));n.setOpacity(i)",
		replace: "i=PTMP.opacity(t);n.setOpacity(i)"
	},
	{
		name: "smaller render delay for remote cars in race modes (reset)",
		find: "const t=.15;if(w.multiplayerConnection.addConnectionLostCallback(",
		replace: "const t=PTMP.renderDelay();if(w.multiplayerConnection.addConnectionLostCallback("
	},
	{
		name: "smaller render delay for remote cars in race modes (update)",
		find: "frames/1e3-e.time,i=.15,r=.1;",
		replace: "frames/1e3-e.time,i=PTMP.renderDelay(),r=.1;"
	},

	// --- car + simulation access ----------------------------------------------------------------
	{
		name: "car: expose its simulation + id",
		find: 'setVisible(e){(0,l.gn)(this,ve,"f").visible=e}',
		replace: 'ptSim(){return(0,l.gn)(this,Z,"f")}ptCarId(){return(0,l.gn)(this,ne,"f")}setVisible(e){(0,l.gn)(this,ve,"f").visible=e}'
	},
	{
		name: "simulation: raw message to the physics worker",
		find: "pauseCar(e,t){const n={messageType:o.PauseCar",
		replace: 'ptPost(e){(0,r.gn)(this,h,"f").postMessage(e)}pauseCar(e,t){const n={messageType:o.PauseCar'
	},
	{
		name: "simulation: pass grid start to the worker",
		find: "carRecording:s?.serialize()??null};return(0,r.gn)(this,h,\"f\").postMessage(m),",
		replace: "carRecording:s?.serialize()??null,ptStart:e.ptGrid?{x:e.position.x,y:e.position.y,z:e.position.z}:null};return(0,r.gn)(this,h,\"f\").postMessage(m),"
	},
	{
		name: "hidden cars also hide their name tag",
		find: '(0,l.gn)(this,be,"f").visible=(0,l.gn)(this,ie,"f").hasStarted&&',
		replace: '(0,l.gn)(this,be,"f").visible=(0,l.gn)(this,ve,"f").visible&&(0,l.gn)(this,ie,"f").hasStarted&&'
	},
	{
		name: "simulation: messages from the physics worker extension",
		find: "const t=e.data;switch(t.messageType){case o.VerifyResult:",
		replace: "const t=e.data;if(100===t.messageType)return void PTMP.onWorkerMessage(t);switch(t.messageType){case o.VerifyResult:"
	}
];
