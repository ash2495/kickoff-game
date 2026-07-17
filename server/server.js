// ============================================================
// KICKOFF DUEL — authoritative Socket.io server for Private
// Match (2v2 or 3v3, 1-6 human players, empty slots filled by
// bots). This owns the entire simulation; clients only send
// input/kick and render whatever position this server broadcasts.
// ============================================================

require('dotenv').config();

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET env var is required (see server/.env.example).');
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { connectDb } = require('./db');
const profile = require('./profile');

const app = express();
app.get('/', (req, res) => res.send('Kickoff Duel server is running.'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// ---- Match constants (mirrors the geometry in www/index.html) ----
const FIELD = { w: 1600, h: 800 };
const GOAL_WIDTH = 180;
const PITCH = { x: 20, y: 20, w: FIELD.w - 40, h: FIELD.h - 40 };
const PLAYER_R = 26;
const BALL_R = 16;
const PLAYER_SPEED = 260;
const BALL_MAX_SPEED = 600;
const BALL_DRAG = 0.96; // per-tick velocity multiplier
const KICK_RANGE = 90;
const KICK_POWER = 520;
const TICK_MS = 50; // 20Hz simulation + broadcast rate
const GOAL_RESET_DELAY_MS = 900;

// Quick Match: how long a public room waits for real players before
// auto-starting with bots filling whatever's still empty
const QUICKMATCH_COUNTDOWN_MS = 15000;

// Safety net for the kickoff-ready handshake below: if a client never signals
// readyForKickoff (crashed, backgrounded, dropped message), don't freeze the
// match forever - let it go live on its own after this long.
const KICKOFF_SAFETY_MS = 12000;

// anti-stalling: if the ball sits pinned near a pitch corner (not moving more
// than a small jitter radius) for this long, reset it and every player back
// to their starting spots instead of letting play stall out indefinitely
const STALL_CORNER_RADIUS = 150;
const STALL_MOVE_THRESHOLD = 60;
const STALL_DURATION_MS = 5000;
const STALL_RESET_DELAY_MS = 500;

const TEAM_SIZES = [2, 3]; // 2v2 (4 players) or 3v3 (6 players)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

// same pool the client uses for VS Bot mode, so bot names feel consistent
// across local and online play
const BOT_NAMES = [
  'RoboStriker', 'IronKicker', 'ByteRunner', 'CircuitAce', 'TurboBoot',
  'SteelToe', 'QuickBot', 'GhostKicker', 'ChromeDribbler', 'ClockworkAce',
  'PixelStriker', 'VoltRunner', 'ScrapKicker', 'NitroBot', 'ShadowStriker',
  'BoltRunner', 'CyberKicker', 'RustyBoot', 'SparkStriker', 'GearGoalie',
];
function randomBotName() {
  return BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
}

const rooms = new Map(); // code -> room state

function clampNum(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function sanitizeTeamSize(size) {
  const n = Number(size);
  return TEAM_SIZES.includes(n) ? n : 2;
}

// each bot gets one of these difficulties at random (see randomBotDifficulty)
// instead of a single room-wide level, so a match's bots feel like a mixed
// bag of opponents rather than uniformly easy/medium/hard
const BOT_DIFFICULTY = {
  easy:   { speed: 90,  reactionMs: 800, hesitateChance: 0.30, kickCooldownMs: 2200, wobble: 1.1 },
  medium: { speed: 150, reactionMs: 450, hesitateChance: 0.15, kickCooldownMs: 1500, wobble: 0.6 },
  hard:   { speed: 210, reactionMs: 150, hesitateChance: 0.03, kickCooldownMs: 900,  wobble: 0.22 },
};
const BOT_DIFFICULTY_LEVELS = Object.keys(BOT_DIFFICULTY);
function randomBotDifficulty() {
  return BOT_DIFFICULTY_LEVELS[Math.floor(Math.random() * BOT_DIFFICULTY_LEVELS.length)];
}

// e.g. teamSize=2 -> ['A1','A2','B1','B2'], teamSize=3 -> ['A1','A2','A3','B1','B2','B3']
function getSlots(teamSize) {
  const slots = [];
  ['A', 'B'].forEach((team) => {
    for (let i = 1; i <= teamSize; i++) slots.push(team + i);
  });
  return slots;
}

// interleaved so teams stay balanced as players join one at a time: A1,B1,A2,B2,...
function getJoinOrder(teamSize) {
  const order = [];
  for (let i = 1; i <= teamSize; i++) { order.push('A' + i); order.push('B' + i); }
  return order;
}

// spreads N players evenly down each side's half of the field (matches the
// existing 0.35/0.65 split exactly when teamSize is 2)
function getStartPos(slots, teamSize) {
  const pos = {};
  slots.forEach((slot) => {
    const team = slot[0];
    const idx = parseInt(slot.slice(1), 10);
    const x = team === 'A' ? FIELD.w * 0.22 : FIELD.w * 0.78;
    const y = FIELD.h * (0.2 + (idx - 0.5) * (0.6 / teamSize));
    pos[slot] = { x, y };
  });
  return pos;
}

function sanitizeName(name) {
  if (typeof name !== 'string') return 'Player';
  const trimmed = name.trim().slice(0, 16);
  return trimmed || 'Player';
}

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoomState(hostSocketId, matchDuration, hostName, teamSize) {
  const code = makeRoomCode();
  const size = sanitizeTeamSize(teamSize);
  const slots = getSlots(size);
  const startPos = getStartPos(slots, size);
  const entities = {};
  slots.forEach((slot) => {
    entities[slot] = {
      x: startPos[slot].x, y: startPos[slot].y, vx: 0, vy: 0,
      team: slot[0], isBot: true, socketId: null, name: randomBotName(),
      difficulty: randomBotDifficulty(), inputVec: { x: 0, y: 0 },
    };
  });
  const room = {
    code,
    teamSize: size,
    slots,
    startPos,
    joinOrder: getJoinOrder(size),
    hostSlot: 'A1',
    matchDuration: matchDuration > 0 ? matchDuration : 0,
    started: false,
    ended: false,
    resetting: false,
    entities,
    ball: { x: FIELD.w / 2, y: FIELD.h / 2, vx: 0, vy: 0 },
    score: { A: 0, B: 0 },
    timeRemaining: null,
    tickHandle: null,
    botState: {},
    stallTracker: null,
    stallResetCount: 0,
    // Quick Match matchmaking fields - unused/false for Private Match rooms
    isPublic: false,
    matchmakeTimer: null,
    matchmakeCountdownEndsAt: null,
    // kickoff-ready handshake fields - populated for real by resetMatchState()
    // once a match actually begins
    kickoffLive: false,
    kickoffReadySlots: new Set(),
    kickoffFallbackTimer: null,
  };
  entities.A1.isBot = false;
  entities.A1.socketId = hostSocketId;
  entities.A1.name = sanitizeName(hostName);
  rooms.set(code, room);
  return room;
}

function findOpenSlot(room) {
  return room.joinOrder.find((slot) => room.entities[slot].isBot);
}

// Quick Match: find an already-waiting public room with the right team size
// and at least one open slot, so a new quickmatch player joins real people
// instead of always spinning up their own room
function findOpenPublicRoom(teamSize) {
  for (const room of rooms.values()) {
    if (room.isPublic && !room.started && room.teamSize === teamSize && findOpenSlot(room)) return room;
  }
  return undefined;
}

function emitLobby(room) {
  const players = {};
  room.slots.forEach((slot) => {
    players[slot] = { connected: !room.entities[slot].isBot, name: room.entities[slot].name || 'Player' };
  });
  io.to(room.code).emit('lobbyUpdate', { code: room.code, players, hostSlot: room.hostSlot, teamSize: room.teamSize, countdownEndsAt: room.matchmakeCountdownEndsAt || null });
}

function resetMatchState(room) {
  room.started = true;
  room.ended = false;
  room.resetting = false;
  room.score = { A: 0, B: 0 };
  room.timeRemaining = room.matchDuration > 0 ? room.matchDuration : null;
  room.slots.forEach((slot) => {
    const e = room.entities[slot];
    e.x = room.startPos[slot].x; e.y = room.startPos[slot].y;
    e.vx = 0; e.vy = 0; e.inputVec = { x: 0, y: 0 };
  });
  room.ball.x = FIELD.w / 2; room.ball.y = FIELD.h / 2;
  room.ball.vx = 0; room.ball.vy = 0;
  room.botState = {};
  room.stallTracker = null;

  // Kickoff-ready handshake: the sim stays frozen (no bot/ball movement, no
  // clock, no scoring) right after matchStarted fires until every connected
  // real player has told us they're actually looking at the pitch (Quick
  // Match's bot-reveal + countdown curtain can take several seconds, and
  // without this gate the match plays out live behind it and can score before
  // anyone sees kickoff). Falls back to going live on its own so a client
  // that never signals can't freeze the match forever.
  room.kickoffLive = false;
  room.kickoffReadySlots = new Set();
  if (room.kickoffFallbackTimer) clearTimeout(room.kickoffFallbackTimer);
  room.kickoffFallbackTimer = setTimeout(() => {
    if (rooms.get(room.code) !== room) return;
    room.kickoffLive = true;
  }, KICKOFF_SAFETY_MS);
}

const PITCH_CORNERS = [
  { x: PITCH.x, y: PITCH.y }, { x: PITCH.x + PITCH.w, y: PITCH.y },
  { x: PITCH.x, y: PITCH.y + PITCH.h }, { x: PITCH.x + PITCH.w, y: PITCH.y + PITCH.h },
];

function checkBallStall(room, now) {
  const b = room.ball;
  const nearCorner = PITCH_CORNERS.some((c) => Math.hypot(b.x - c.x, b.y - c.y) < STALL_CORNER_RADIUS);
  if (!nearCorner) { room.stallTracker = null; return; }

  if (!room.stallTracker || Math.hypot(b.x - room.stallTracker.x, b.y - room.stallTracker.y) > STALL_MOVE_THRESHOLD) {
    room.stallTracker = { x: b.x, y: b.y, since: now };
    return;
  }

  if (now - room.stallTracker.since >= STALL_DURATION_MS) {
    room.stallTracker = null;
    room.resetting = true;
    room.stallResetCount++;
    setTimeout(() => {
      if (rooms.get(room.code) !== room) return; // room was torn down mid-reset
      room.slots.forEach((slot) => {
        const e = room.entities[slot];
        e.x = room.startPos[slot].x; e.y = room.startPos[slot].y; e.vx = 0; e.vy = 0;
      });
      room.ball.x = FIELD.w / 2; room.ball.y = FIELD.h / 2; room.ball.vx = 0; room.ball.vy = 0;
      room.resetting = false;
    }, STALL_RESET_DELAY_MS);
  }
}

function clampToPitch(e) {
  const minX = PITCH.x + PLAYER_R, maxX = PITCH.x + PITCH.w - PLAYER_R;
  const minY = PITCH.y + PLAYER_R, maxY = PITCH.y + PITCH.h - PLAYER_R;
  e.x = clampNum(e.x, minX, maxX);
  e.y = clampNum(e.y, minY, maxY);
}

function updatePlayers(room, dt) {
  room.slots.forEach((slot) => {
    const e = room.entities[slot];
    if (e.isBot) return;
    let { x: vx, y: vy } = e.inputVec;
    const mag = Math.hypot(vx, vy);
    if (mag > 1) { vx /= mag; vy /= mag; }
    e.vx = vx * PLAYER_SPEED;
    e.vy = vy * PLAYER_SPEED;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    clampToPitch(e);
  });
}

function updateBots(room, dt) {
  const now = Date.now();
  room.slots.forEach((slot) => {
    const e = room.entities[slot];
    if (!e.isBot) return;
    const cfg = BOT_DIFFICULTY[e.difficulty] || BOT_DIFFICULTY.easy;
    let bs = room.botState[slot];
    if (!bs) bs = room.botState[slot] = { targetRefresh: 0, target: null, hesitate: false, lastKick: 0 };

    // reaction time + hesitation chance both tighten as difficulty increases
    if (now - bs.targetRefresh > cfg.reactionMs) {
      bs.targetRefresh = now;
      bs.target = { x: room.ball.x, y: room.ball.y };
      bs.hesitate = Math.random() < cfg.hesitateChance;
    }
    const target = bs.target || room.ball;
    const dx = target.x - e.x, dy = target.y - e.y;
    const dist = Math.hypot(dx, dy);

    if (bs.hesitate || dist <= 4) {
      e.vx = 0; e.vy = 0;
    } else {
      e.vx = (dx / dist) * cfg.speed;
      e.vy = (dy / dist) * cfg.speed;
    }
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    clampToPitch(e);

    const realDist = Math.hypot(room.ball.x - e.x, room.ball.y - e.y);
    if (!room.resetting && realDist < KICK_RANGE && now - bs.lastKick > cfg.kickCooldownMs) {
      bs.lastKick = now;
      const goalX = e.team === 'A' ? FIELD.w - 20 : 20; // attack the opposing goal
      const baseAngle = Math.atan2(FIELD.h / 2 - e.y, goalX - e.x);
      const wobble = (Math.random() - 0.5) * cfg.wobble;
      const aimAngle = baseAngle + wobble;
      room.ball.vx = Math.cos(aimAngle) * KICK_POWER;
      room.ball.vy = Math.sin(aimAngle) * KICK_POWER;
    }
  });
}

function updateBall(room, dt) {
  const b = room.ball;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.vx *= BALL_DRAG;
  b.vy *= BALL_DRAG;

  const speed = Math.hypot(b.vx, b.vy);
  if (speed > BALL_MAX_SPEED) {
    b.vx = (b.vx / speed) * BALL_MAX_SPEED;
    b.vy = (b.vy / speed) * BALL_MAX_SPEED;
  } else if (speed < 2) {
    b.vx = 0; b.vy = 0;
  }

  const minY = PITCH.y + BALL_R, maxY = PITCH.y + PITCH.h - BALL_R;
  if (b.y < minY) { b.y = minY; b.vy *= -0.6; }
  if (b.y > maxY) { b.y = maxY; b.vy *= -0.6; }

  const goalY0 = FIELD.h / 2 - GOAL_WIDTH / 2, goalY1 = FIELD.h / 2 + GOAL_WIDTH / 2;
  const inMouth = b.y >= goalY0 && b.y <= goalY1;
  const minX = PITCH.x + BALL_R, maxX = PITCH.x + PITCH.w - BALL_R;

  if (b.x < minX) {
    if (inMouth) { if (b.x < -10) { b.x = -10; b.vx *= -0.4; } }
    else { b.x = minX; b.vx *= -0.6; }
  }
  if (b.x > maxX) {
    if (inMouth) { if (b.x > FIELD.w + 10) { b.x = FIELD.w + 10; b.vx *= -0.4; } }
    else { b.x = maxX; b.vx *= -0.6; }
  }

  // hard failsafe: regardless of the goal-mouth exception above, the ball
  // should never end up meaningfully outside the pitch + net pockets
  b.x = clampNum(b.x, -14, FIELD.w + 14);
  b.y = clampNum(b.y, minY, maxY);
}

function separateCircles(a, b, minDist) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist > 0 && dist < minDist) {
    const overlap = (minDist - dist) / 2;
    const nx = dx / dist, ny = dy / dist;
    a.x -= nx * overlap; a.y -= ny * overlap;
    b.x += nx * overlap; b.y += ny * overlap;
    clampToPitch(a); clampToPitch(b);
  }
}

function resolveCollisions(room) {
  const slots = room.slots;
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      separateCircles(room.entities[slots[i]], room.entities[slots[j]], PLAYER_R * 2);
    }
  }
  slots.forEach((slot) => {
    const e = room.entities[slot];
    const dx = room.ball.x - e.x, dy = room.ball.y - e.y;
    const dist = Math.hypot(dx, dy);
    const minDist = PLAYER_R + BALL_R;
    if (dist > 0 && dist < minDist) {
      const overlap = minDist - dist;
      const nx = dx / dist, ny = dy / dist;
      room.ball.x += nx * overlap;
      room.ball.y += ny * overlap;
      const push = 180 * 0.15;
      room.ball.vx += nx * push;
      room.ball.vy += ny * push;
    }
  });
}

function checkGoals(room) {
  if (room.resetting || room.ended) return;
  const b = room.ball;
  const goalY0 = FIELD.h / 2 - GOAL_WIDTH / 2, goalY1 = FIELD.h / 2 + GOAL_WIDTH / 2;
  if (b.y < goalY0 || b.y > goalY1) return;
  if (b.x <= 4) scoreGoal(room, 'B');       // ball crossed A's line -> B scores
  else if (b.x >= FIELD.w - 4) scoreGoal(room, 'A'); // ball crossed B's line -> A scores
}

function scoreGoal(room, team) {
  room.resetting = true;
  room.score[team]++;
  setTimeout(() => {
    if (rooms.get(room.code) !== room) return; // room was torn down mid-reset
    room.slots.forEach((slot) => {
      const e = room.entities[slot];
      e.x = room.startPos[slot].x; e.y = room.startPos[slot].y; e.vx = 0; e.vy = 0;
    });
    room.ball.x = FIELD.w / 2; room.ball.y = FIELD.h / 2; room.ball.vx = 0; room.ball.vy = 0;
    room.resetting = false;
  }, GOAL_RESET_DELAY_MS);
}

function broadcastState(room) {
  const entities = {};
  room.slots.forEach((slot) => { entities[slot] = { x: room.entities[slot].x, y: room.entities[slot].y }; });
  io.to(room.code).emit('state', {
    entities,
    ball: { x: room.ball.x, y: room.ball.y },
    score: room.score,
    timeRemaining: room.timeRemaining,
    ended: room.ended,
    stallResetCount: room.stallResetCount,
  });
}

function endMatch(room) {
  room.ended = true;
  broadcastState(room);
  if (room.tickHandle) { clearInterval(room.tickHandle); room.tickHandle = null; }
}

function tick(room) {
  if (room.ended) return;
  const dt = TICK_MS / 1000;

  if (!room.kickoffLive) {
    // frozen at kickoff formation - still broadcast so clients render the
    // static lineup instead of a blank/stale frame while they wait
    broadcastState(room);
    return;
  }

  if (room.matchDuration > 0) {
    room.timeRemaining -= dt;
    if (room.timeRemaining <= 0) {
      room.timeRemaining = 0;
      endMatch(room);
      return;
    }
  }

  if (!room.resetting) {
    updateBots(room, dt);
    updatePlayers(room, dt);
    updateBall(room, dt);
    resolveCollisions(room);
    checkGoals(room);
    checkBallStall(room, Date.now());
  } else {
    room.stallTracker = null;
  }

  broadcastState(room);
}

function startTick(room) {
  if (room.tickHandle) return;
  room.tickHandle = setInterval(() => tick(room), TICK_MS);
}

// shared by the host-triggered startMatch/restartMatch handlers AND the
// Quick Match countdown timer / full-room auto-start - the latter two have
// no host socket to gate on, so this needs to be callable directly.
// Note: restartMatch legitimately calls this on an already-started room
// (that's what a rematch is), so there's no `room.started` guard here -
// clearing matchmakeTimer below is what actually prevents a stray countdown
// firing a second time after an early manual start, since the pending
// setTimeout is cancelled the first time this runs.
function beginMatch(room) {
  if (room.matchmakeTimer) { clearTimeout(room.matchmakeTimer); room.matchmakeTimer = null; }
  room.matchmakeCountdownEndsAt = null;
  resetMatchState(room);
  io.to(room.code).emit('matchStarted');
  startTick(room);
}

// flips the kickoff freeze off once every currently-connected real player
// slot has signaled readyForKickoff
function checkKickoffReady(room) {
  if (room.kickoffLive) return;
  const connectedSlots = room.slots.filter((s) => !room.entities[s].isBot);
  if (connectedSlots.every((s) => room.kickoffReadySlots.has(s))) {
    room.kickoffLive = true;
    if (room.kickoffFallbackTimer) { clearTimeout(room.kickoffFallbackTimer); room.kickoffFallbackTimer = null; }
  }
}

function handleLeave(socket) {
  const code = socket.data.code, slot = socket.data.slot;
  socket.data.code = null;
  socket.data.slot = null;
  if (!code || !slot) return;
  socket.leave(code);

  const room = rooms.get(code);
  if (!room) return;
  const e = room.entities[slot];
  if (e) { e.isBot = true; e.socketId = null; e.name = randomBotName(); e.difficulty = randomBotDifficulty(); }

  const connectedSlots = room.slots.filter((s) => !room.entities[s].isBot);
  if (connectedSlots.length === 0) {
    if (room.tickHandle) clearInterval(room.tickHandle);
    if (room.matchmakeTimer) clearTimeout(room.matchmakeTimer);
    if (room.kickoffFallbackTimer) clearTimeout(room.kickoffFallbackTimer);
    rooms.delete(code);
    return;
  }
  if (slot === room.hostSlot) room.hostSlot = connectedSlots[0];
  // the player who just left might have been the last one still-frozen
  // kickoff was waiting on - recheck so remaining players aren't stuck
  if (room.started && !room.kickoffLive) checkKickoffReady(room);
  emitLobby(room);
}

// Guards createRoom/joinRoom/quickMatch against the same socket landing in
// two slots at once (e.g. spam-tapping Quick Match before the first ack
// returns - each tap fired its own quickMatch call, and the 2nd found the
// room the 1st had just created and joined it into a second slot). Self-heals
// if socket.data.code points at a room that's already been torn down, so a
// genuinely stale value can't permanently block a real rejoin.
function alreadyInRoom(socket) {
  if (socket.data.code && rooms.has(socket.data.code)) return true;
  socket.data.code = null;
  socket.data.slot = null;
  return false;
}

io.on('connection', (socket) => {
  socket.on('createRoom', (data, cb) => {
    if (typeof cb !== 'function') return;
    if (alreadyInRoom(socket)) return cb({ ok: false, error: 'Already in a match.' });
    const matchDuration = Number(data && data.matchDuration) || 0;
    const room = createRoomState(socket.id, matchDuration, data && data.name, data && data.teamSize);
    socket.join(room.code);
    socket.data.code = room.code;
    socket.data.slot = 'A1';
    cb({ ok: true, code: room.code, slot: 'A1', isHost: true });
    emitLobby(room);
  });

  socket.on('joinRoom', (data, cb) => {
    if (typeof cb !== 'function') return;
    if (alreadyInRoom(socket)) return cb({ ok: false, error: 'Already in a match.' });
    const code = ((data && data.code) || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: "Couldn't find that room." });
    if (room.started) return cb({ ok: false, error: 'That match already started.' });
    const slot = findOpenSlot(room);
    if (!slot) return cb({ ok: false, error: 'That room is full.' });

    room.entities[slot].isBot = false;
    room.entities[slot].socketId = socket.id;
    room.entities[slot].name = sanitizeName(data && data.name);
    socket.join(code);
    socket.data.code = code;
    socket.data.slot = slot;
    cb({ ok: true, code, slot, isHost: slot === room.hostSlot });
    emitLobby(room);
  });

  // auto-matchmaking: join an already-waiting public room for this team
  // size if one exists, otherwise create one and start a countdown that
  // auto-starts the match (bots fill whatever's still empty) if no one
  // else joins in time
  socket.on('quickMatch', (data, cb) => {
    if (typeof cb !== 'function') return;
    if (alreadyInRoom(socket)) return cb({ ok: false, error: 'Already in a match.' });
    const teamSize = sanitizeTeamSize(data && data.teamSize);
    const existing = findOpenPublicRoom(teamSize);

    if (existing) {
      const slot = findOpenSlot(existing);
      existing.entities[slot].isBot = false;
      existing.entities[slot].socketId = socket.id;
      existing.entities[slot].name = sanitizeName(data && data.name);
      socket.join(existing.code);
      socket.data.code = existing.code;
      socket.data.slot = slot;
      cb({ ok: true, code: existing.code, slot, isHost: slot === existing.hostSlot });
      if (!findOpenSlot(existing)) {
        beginMatch(existing); // room just filled up - no reason to keep waiting
      } else {
        emitLobby(existing);
      }
      return;
    }

    const matchDuration = Number(data && data.matchDuration) || 0;
    const room = createRoomState(socket.id, matchDuration, data && data.name, teamSize);
    room.isPublic = true;
    room.matchmakeCountdownEndsAt = Date.now() + QUICKMATCH_COUNTDOWN_MS;
    room.matchmakeTimer = setTimeout(() => {
      if (rooms.get(room.code) !== room) return; // room was torn down (e.g. everyone left)
      beginMatch(room);
    }, QUICKMATCH_COUNTDOWN_MS);
    socket.join(room.code);
    socket.data.code = room.code;
    socket.data.slot = 'A1';
    cb({ ok: true, code: room.code, slot: 'A1', isHost: true });
    emitLobby(room);
  });

  socket.on('setName', (data) => {
    const code = data && data.code;
    const room = rooms.get(code);
    if (!room || socket.data.code !== code) return;
    const e = room.entities[socket.data.slot];
    if (!e || e.isBot) return;
    e.name = sanitizeName(data && data.name);
    emitLobby(room);
  });

  // manual team/slot selection in the lobby - move yourself into an open
  // (bot) slot, swapping your old slot back to a bot
  socket.on('switchSlot', (data, cb) => {
    const ok = () => { if (typeof cb === 'function') cb({ ok: true }); };
    const fail = (error) => { if (typeof cb === 'function') cb({ ok: false, error }); };

    const code = data && data.code;
    const room = rooms.get(code);
    if (!room || socket.data.code !== code) return fail('Not in that room.');
    if (room.started) return fail('The match already started.');

    const fromSlot = socket.data.slot;
    const toSlot = data && data.slot;
    const fromEntity = room.entities[fromSlot];
    if (!fromEntity || fromEntity.isBot) return fail('You are not in this room.');
    if (!toSlot || !room.entities[toSlot]) return fail('Invalid slot.');
    if (toSlot === fromSlot) return ok();
    const toEntity = room.entities[toSlot];
    if (!toEntity.isBot) return fail('That slot is taken.');

    toEntity.isBot = false;
    toEntity.socketId = fromEntity.socketId;
    toEntity.name = fromEntity.name;
    fromEntity.isBot = true;
    fromEntity.socketId = null;
    fromEntity.name = randomBotName();
    fromEntity.difficulty = randomBotDifficulty();

    if (room.hostSlot === fromSlot) room.hostSlot = toSlot;
    socket.data.slot = toSlot;

    ok();
    emitLobby(room);
  });

  socket.on('startMatch', (data) => {
    const code = data && data.code;
    const room = rooms.get(code);
    if (!room || socket.data.code !== code || socket.data.slot !== room.hostSlot) return;
    beginMatch(room);
  });

  socket.on('restartMatch', (data) => {
    const code = data && data.code;
    const room = rooms.get(code);
    if (!room || socket.data.code !== code || socket.data.slot !== room.hostSlot) return;
    beginMatch(room);
  });

  // Client tells us it's actually showing the pitch (Private Match: right
  // after mounting; Quick Match: only once its bot-reveal/countdown curtain
  // finishes) - see the kickoffLive gate in tick() for why this exists.
  socket.on('readyForKickoff', (data) => {
    const code = data && data.code;
    const room = rooms.get(code);
    if (!room || socket.data.code !== code || !room.started || room.kickoffLive) return;
    room.kickoffReadySlots.add(socket.data.slot);
    checkKickoffReady(room);
  });

  socket.on('input', (data) => {
    const code = data && data.code;
    const room = rooms.get(code);
    if (!room || socket.data.code !== code) return;
    const e = room.entities[socket.data.slot];
    const vec = data && data.vec;
    if (!e || e.isBot || !vec || typeof vec.x !== 'number' || typeof vec.y !== 'number') return;
    e.inputVec = { x: clampNum(vec.x, -1, 1), y: clampNum(vec.y, -1, 1) };
  });

  socket.on('kick', (data) => {
    const code = data && data.code;
    const room = rooms.get(code);
    if (!room || socket.data.code !== code || !room.started || room.ended || room.resetting || !room.kickoffLive) return;
    const e = room.entities[socket.data.slot];
    if (!e || e.isBot) return;
    const dx = room.ball.x - e.x, dy = room.ball.y - e.y;
    if (Math.hypot(dx, dy) < KICK_RANGE) {
      const angle = Math.atan2(dy, dx);
      room.ball.vx = Math.cos(angle) * KICK_POWER;
      room.ball.vy = Math.sin(angle) * KICK_POWER;
    }
  });

  socket.on('leaveRoom', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));

  // ---- Player profiles (Guest/Google login, profile edits) ----
  // independent of the match/room system above - these just read/write
  // MongoDB via server/profile.js and ack the result, same convention as
  // every handler above
  socket.on('guestLogin', async (data, cb) => {
    if (typeof cb !== 'function') return;
    cb(await profile.guestLogin(data && data.deviceId));
  });

  socket.on('googleLogin', async (data, cb) => {
    if (typeof cb !== 'function') return;
    cb(await profile.googleLogin(data && data.idToken, data && data.deviceId));
  });

  socket.on('updateProfile', async (data, cb) => {
    if (typeof cb !== 'function') return;
    cb(await profile.updateProfile(data && data.userId, data && data.authToken, {
      name: data && data.name,
      country: data && data.country,
      avatar: data && data.avatar,
    }));
  });
});

connectDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Kickoff Duel server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB - server not starting:', err.message);
    process.exit(1);
  });
