// ============================================================
// KICKOFF DUEL — authoritative Socket.io server for Private
// Match (2v2, 1-4 human players, empty slots filled by bots).
// This owns the entire simulation; clients only send input/kick
// and render whatever position this server broadcasts.
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

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
const BOT_SPEED = 90;
const KICK_RANGE = 130;
const KICK_POWER = 520;
const TICK_MS = 50; // 20Hz simulation + broadcast rate
const GOAL_RESET_DELAY_MS = 900;

const SLOTS = ['A1', 'A2', 'B1', 'B2'];
const JOIN_ORDER = ['A1', 'B1', 'A2', 'B2']; // fills teams evenly as players arrive
const START_POS = {
  A1: { x: FIELD.w * 0.22, y: FIELD.h * 0.35 },
  A2: { x: FIELD.w * 0.22, y: FIELD.h * 0.65 },
  B1: { x: FIELD.w * 0.78, y: FIELD.h * 0.35 },
  B2: { x: FIELD.w * 0.78, y: FIELD.h * 0.65 },
};
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

const rooms = new Map(); // code -> room state

function clampNum(v, min, max) {
  return Math.min(max, Math.max(min, v));
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

function createRoomState(hostSocketId, matchDuration, hostName) {
  const code = makeRoomCode();
  const entities = {};
  SLOTS.forEach((slot) => {
    entities[slot] = {
      x: START_POS[slot].x, y: START_POS[slot].y, vx: 0, vy: 0,
      team: slot[0], isBot: true, socketId: null, name: 'Player', inputVec: { x: 0, y: 0 },
    };
  });
  const room = {
    code,
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
  };
  entities.A1.isBot = false;
  entities.A1.socketId = hostSocketId;
  entities.A1.name = sanitizeName(hostName);
  rooms.set(code, room);
  return room;
}

function findOpenSlot(room) {
  return JOIN_ORDER.find((slot) => room.entities[slot].isBot);
}

function emitLobby(room) {
  const players = {};
  SLOTS.forEach((slot) => {
    players[slot] = { connected: !room.entities[slot].isBot, name: room.entities[slot].name || 'Player' };
  });
  io.to(room.code).emit('lobbyUpdate', { code: room.code, players, hostSlot: room.hostSlot });
}

function resetMatchState(room) {
  room.started = true;
  room.ended = false;
  room.resetting = false;
  room.score = { A: 0, B: 0 };
  room.timeRemaining = room.matchDuration > 0 ? room.matchDuration : null;
  SLOTS.forEach((slot) => {
    const e = room.entities[slot];
    e.x = START_POS[slot].x; e.y = START_POS[slot].y;
    e.vx = 0; e.vy = 0; e.inputVec = { x: 0, y: 0 };
  });
  room.ball.x = FIELD.w / 2; room.ball.y = FIELD.h / 2;
  room.ball.vx = 0; room.ball.vy = 0;
  room.botState = {};
}

function clampToPitch(e) {
  const minX = PITCH.x + PLAYER_R, maxX = PITCH.x + PITCH.w - PLAYER_R;
  const minY = PITCH.y + PLAYER_R, maxY = PITCH.y + PITCH.h - PLAYER_R;
  e.x = clampNum(e.x, minX, maxX);
  e.y = clampNum(e.y, minY, maxY);
}

function updatePlayers(room, dt) {
  SLOTS.forEach((slot) => {
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
  SLOTS.forEach((slot) => {
    const e = room.entities[slot];
    if (!e.isBot) return;
    let bs = room.botState[slot];
    if (!bs) bs = room.botState[slot] = { targetRefresh: 0, target: null, hesitate: false, lastKick: 0 };

    // slow "reaction time" + occasional hesitation, same easy-mode feel as the local bot
    if (now - bs.targetRefresh > 800) {
      bs.targetRefresh = now;
      bs.target = { x: room.ball.x, y: room.ball.y };
      bs.hesitate = Math.random() < 0.3;
    }
    const target = bs.target || room.ball;
    const dx = target.x - e.x, dy = target.y - e.y;
    const dist = Math.hypot(dx, dy);

    if (bs.hesitate || dist <= 4) {
      e.vx = 0; e.vy = 0;
    } else {
      e.vx = (dx / dist) * BOT_SPEED;
      e.vy = (dy / dist) * BOT_SPEED;
    }
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    clampToPitch(e);

    const realDist = Math.hypot(room.ball.x - e.x, room.ball.y - e.y);
    if (!room.resetting && realDist < KICK_RANGE && now - bs.lastKick > 2200) {
      bs.lastKick = now;
      const goalX = e.team === 'A' ? FIELD.w - 20 : 20; // attack the opposing goal
      const baseAngle = Math.atan2(FIELD.h / 2 - e.y, goalX - e.x);
      const wobble = (Math.random() - 0.5) * 1.1; // wide, inaccurate shots
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
  for (let i = 0; i < SLOTS.length; i++) {
    for (let j = i + 1; j < SLOTS.length; j++) {
      separateCircles(room.entities[SLOTS[i]], room.entities[SLOTS[j]], PLAYER_R * 2);
    }
  }
  SLOTS.forEach((slot) => {
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
    SLOTS.forEach((slot) => {
      const e = room.entities[slot];
      e.x = START_POS[slot].x; e.y = START_POS[slot].y; e.vx = 0; e.vy = 0;
    });
    room.ball.x = FIELD.w / 2; room.ball.y = FIELD.h / 2; room.ball.vx = 0; room.ball.vy = 0;
    room.resetting = false;
  }, GOAL_RESET_DELAY_MS);
}

function broadcastState(room) {
  const entities = {};
  SLOTS.forEach((slot) => { entities[slot] = { x: room.entities[slot].x, y: room.entities[slot].y }; });
  io.to(room.code).emit('state', {
    entities,
    ball: { x: room.ball.x, y: room.ball.y },
    score: room.score,
    timeRemaining: room.timeRemaining,
    ended: room.ended,
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
  }

  broadcastState(room);
}

function startTick(room) {
  if (room.tickHandle) return;
  room.tickHandle = setInterval(() => tick(room), TICK_MS);
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
  if (e) { e.isBot = true; e.socketId = null; }

  const connectedSlots = SLOTS.filter((s) => !room.entities[s].isBot);
  if (connectedSlots.length === 0) {
    if (room.tickHandle) clearInterval(room.tickHandle);
    rooms.delete(code);
    return;
  }
  if (slot === room.hostSlot) room.hostSlot = connectedSlots[0];
  emitLobby(room);
}

io.on('connection', (socket) => {
  socket.on('createRoom', (data, cb) => {
    if (typeof cb !== 'function') return;
    const matchDuration = Number(data && data.matchDuration) || 0;
    const room = createRoomState(socket.id, matchDuration, data && data.name);
    socket.join(room.code);
    socket.data.code = room.code;
    socket.data.slot = 'A1';
    cb({ ok: true, code: room.code, slot: 'A1', isHost: true });
    emitLobby(room);
  });

  socket.on('joinRoom', (data, cb) => {
    if (typeof cb !== 'function') return;
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

  socket.on('setName', (data) => {
    const code = data && data.code;
    const room = rooms.get(code);
    if (!room || socket.data.code !== code) return;
    const e = room.entities[socket.data.slot];
    if (!e || e.isBot) return;
    e.name = sanitizeName(data && data.name);
    emitLobby(room);
  });

  socket.on('startMatch', (data) => {
    const code = data && data.code;
    const room = rooms.get(code);
    if (!room || socket.data.code !== code || socket.data.slot !== room.hostSlot) return;
    resetMatchState(room);
    io.to(code).emit('matchStarted');
    startTick(room);
  });

  socket.on('restartMatch', (data) => {
    const code = data && data.code;
    const room = rooms.get(code);
    if (!room || socket.data.code !== code || socket.data.slot !== room.hostSlot) return;
    resetMatchState(room);
    io.to(code).emit('matchStarted');
    startTick(room);
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
    if (!room || socket.data.code !== code || !room.started || room.ended || room.resetting) return;
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
});

server.listen(PORT, () => {
  console.log(`Kickoff Duel server listening on port ${PORT}`);
});
