# Kickoff Duel — Private Match Server

Authoritative Socket.io server for Kickoff Duel's Private Match mode (2v2, up to
4 human players; empty slots are filled by bots). The client (`www/index.html`)
sends only joystick vectors and kick taps — this server runs the whole
simulation (movement, ball physics, collisions, goals, timer) and broadcasts
positions ~20 times/sec.

## Run locally

```
npm install
npm start
```

Listens on `PORT` env var, defaulting to `3000`.

Then in the app's Settings panel, set **Multiplayer Server URL** to
`http://localhost:3000` (or your machine's LAN IP if testing from a phone).

## Deploy (e.g. Railway)

1. Push this repo, set the service's root directory to `server/`.
2. Railway auto-detects Node and runs `npm install && npm start`; it injects
   `PORT` automatically.
3. Copy the deployed URL into the app's Settings → Multiplayer Server URL.

## Protocol

Client → server:
- `createRoom({ matchDuration })` → ack `{ ok, code, slot, isHost }`
- `joinRoom({ code })` → ack `{ ok, code, slot, isHost }`
- `startMatch({ code })` / `restartMatch({ code })` — host only
- `input({ code, vec: {x,y} })` — joystick vector, clamped to unit length
- `kick({ code })`
- `leaveRoom()`

Server → client (room-scoped):
- `lobbyUpdate({ code, players, hostSlot })`
- `matchStarted()`
- `state({ entities, ball, score, timeRemaining, ended })`

Rooms are in-memory only — restarting the server drops all active matches.
