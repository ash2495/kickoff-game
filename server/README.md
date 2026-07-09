# Kickoff Duel — Private Match Server

Authoritative Socket.io server for Kickoff Duel's Private Match mode (2v2 or
3v3, up to 6 human players; empty slots are filled by bots). The client
(`www/index.html`) sends only joystick vectors and kick taps — this server
runs the whole simulation (movement, ball physics, collisions, goals, timer,
anti-stall corner reset) and broadcasts positions ~20 times/sec.

## Run locally

```
npm install
npm start
```

Listens on `PORT` env var, defaulting to `3000`.

Then in the app's Settings panel, set **Multiplayer Server URL** to
`http://localhost:3000` (or your machine's LAN IP if testing from a phone).

## Deploy on Railway

1. Push this repo, set the service's root directory to `server/`.
2. Railway auto-detects Node and runs `npm install && npm start`; it injects
   `PORT` automatically.
3. In Settings → Regions & Replicas, pick the region closest to your players
   (Railway's closest to India is Asia Southeast / Singapore — there's no
   India-specific region on Railway).
4. Copy the deployed URL into the app's Settings → Multiplayer Server URL.

### Lower latency from India

Railway's closest region (Singapore) still has meaningful latency for
players in India. Fly.io has an actual Mumbai data center (region `bom`),
which would cut that significantly, but it's a paid usage-based service
(a small ongoing cost, plus it requires an account-verification step for
new accounts) and needs a `Dockerfile` + `fly.toml` that don't currently
exist in this repo. Revisit this if latency becomes a bigger problem -
it would need a `Dockerfile`, a `fly.toml` pinned to `primary_region = "bom"`,
and updating `DEFAULT_SERVER_URL` in `www/index.html` afterward.

## Protocol

Client → server:
- `createRoom({ matchDuration, name, teamSize })` → ack `{ ok, code, slot, isHost }` — `teamSize` is `2` or `3` (defaults to `2`)
- `joinRoom({ code, name })` → ack `{ ok, code, slot, isHost }`
- `setName({ code, name })` — rename mid-lobby
- `startMatch({ code })` / `restartMatch({ code })` — host only
- `input({ code, vec: {x,y} })` — joystick vector, clamped to unit length
- `kick({ code })`
- `leaveRoom()`

Server → client (room-scoped):
- `lobbyUpdate({ code, players, hostSlot, teamSize })`
- `matchStarted()`
- `state({ entities, ball, score, timeRemaining, ended, stallResetCount })`

Rooms are in-memory only — restarting the server drops all active matches.
