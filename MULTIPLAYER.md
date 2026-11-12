# PolyTrack online multiplayer

This repo adds three online multiplayer modes and power-ups to PolyTrack 0.6.0.

| Mode | Players | What it is |
| --- | --- | --- |
| **Ghost Time Trial** | up to 5 | The host picks a track, everyone drives it and chases the best time. Other players show up as see-through ghost cars, so you can see them but drive straight through them. |
| **Race** | up to 5 | The host presses **Start Race**. Everyone lines up on a starting grid, a 3-2-1 countdown runs, and you can't move before GO. Cars collide, so you can bump and knock each other off. If you crash (flip over, fall off) or press reset, you restart from your grid spot while the race clock keeps running. Results are ranked by race time; anyone who leaves is a DNF. **Rematch** starts another one. |
| **Tournament** | up to 8 | A knockout bracket. Players are randomly paired 1v1, and each round is raced on a random **official** track (never community tracks). Each player sees and collides only with their own opponent. The winner of each match advances, odd player counts get a bye, and rounds continue until one champion is left. |

**Power-ups** can be switched on by the host for any mode. Driving through a checkpoint spins an item roulette, and you press **E** (or tap the item box) to use what you get:

- **Nitro**: a strong forward boost for about 1.3 s.
- **Super Grip**: about 6 s of extra traction. Cornering slides are cut and the car is pressed into the road.
- **Shockwave** (Race and Tournament only): blasts nearby opponents sideways and up.

Runs that use power-ups, or that start from a race grid, are not saved as personal records or leaderboard times.

## Running it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd server
npm install
npm start
```

Then open <http://localhost:8090/>. That one server both serves the game and runs the matchmaking (invite codes).

To play:

1. Click **Multiplayer**, then **Host**.
2. Pick a **Multiplayer Mode** (Ghost Time Trial / Race / Tournament), turn power-ups on or off, pick a track, and click **Host**.
3. Click **Invite** (top left) and send your friends the 5-letter code.
4. Friends open the same site, click **Multiplayer**, type the code and click **Join**.
5. In Race and Tournament modes, the host starts things from the panel in the top-right corner.

### Playing with friends on other computers

Everyone has to reach the same server.

- **Same Wi-Fi / LAN:** run the server on one computer and have friends open `http://<that computer's IP>:8090/`.
- **Over the internet:** put the server somewhere public. Any Node host works (Render, Railway, Fly.io, a VPS...): deploy this repo and run `node server/server.js`. The host's `PORT` environment variable is respected. For a quick test you can also use a tunnel such as `cloudflared tunnel --url http://localhost:8090`.

Once the players are matched, game traffic goes directly between their browsers (WebRTC). The server only passes the first handshake. On a few strict networks (some school or corporate firewalls) a direct connection isn't possible. You can add a TURN server for those:

```bash
ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:your.turn.server:3478","username":"u","credential":"p"}]' npm start
```

### Hosting the game somewhere else (e.g. GitHub Pages)

If the game files are served from a different site than the server, point the game at your server by adding this line to `index.html` before the other scripts:

```html
<script>window.PTMP_SERVER = "https://your-multiplayer-server.example.com";</script>
```

Then run the server with `SERVE_STATIC=0` so it only does matchmaking.

## How it's built

The game ships as minified, compiled bundles with no source code. The multiplayer add-on therefore works like a mod:

- `mp/multiplayer.js` holds all the main-thread logic: modes, lobby panel, countdown, race and tournament rules, power-ups and messages between players. Custom messages travel over the game's own WebRTC data channel.
- `mp/worker-ext.js` is the physics-worker extension. The physics engine (Bullet compiled to WebAssembly) simulates each car alone, so car-to-car contact, Nitro, grip and Shockwave are applied by adjusting the car's rigid body velocity between simulation steps. Contact uses an oriented-box test against the other player's latest networked position, and each player's game applies its own half of every bump. Bounces are limited to realistic amounts, so lag can't fling cars. None of this runs unless a multiplayer mode asks for it, so solo play and leaderboard replays are simulated exactly as before.
- `tools/patch-bundles.js` (with `tools/patches-main.js` and `tools/patches-worker.js`) applies about 30 small exact-text patches that make the bundles call into those two files. It always starts from the original bundles in git (commit `d6333d4`). If you change a patch, re-run it:

  ```bash
  node tools/patch-bundles.js
  ```

- `server/server.js` is the static file server plus the matchmaking/signalling server. It replaces the game's original `vps.kodub.com` multiplayer endpoints.

Starting grid positions (up to 8 slots) were checked in the physics engine on all 17 official tracks. Custom tracks with very narrow starts might put the outer grid slots off the road.
