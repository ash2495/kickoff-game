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
// x/y/w/h and GOAL_WIDTH measured directly off the 6 pitch textures' own
// touchline/goal-net pixels. Re-calibrated once more after finding the
// earlier X measurement had used the goal's own BACK wall (net depth) as a
// stand-in for the touchline, which is wrong - the true touchline runs
// flush with the goal's FRONT/opening, not its back. Confirmed by direct
// pixel measurement on all 6 (after per-pitch zoom/crop correction so they
// share this exact position): touchlines at 10.15%/89.85% width,
// 16.9%/83% height. Goal height (40%-60%) was unaffected by this mistake
// and stays as before.
const GOAL_WIDTH = 160; // 40%-60% of FIELD.h
const PITCH = { x: 162, y: 135, w: 1276, h: 529 }; // 10.15%/89.85% width, 16.9%/83% height
const PLAYER_R = 26;
const BALL_R = 16;
// how far into the goal net (past PITCH's x bounds) the ball's CENTER may
// travel before hitting the net's actual back wall in the art. Pixel-
// measured on the regenerated stadium art: the net's back wall sits right
// at the touchline itself (PITCH.x/right), not further back into the
// crowd - so this is PITCH.x adjusted by BALL_R (not PITCH.x directly),
// since it's the ball's radius that must stop at the wall, not its center;
// using PITCH.x directly here would let the near edge of the ball (center
// - BALL_R) poke BALL_R past the wall into the crowd.
const NET_MIN_X = PITCH.x + BALL_R;
const NET_MAX_X = PITCH.x + PITCH.w - BALL_R;
const PLAYER_SPEED = 260;
const BALL_MAX_SPEED = 600;
const BALL_DRAG = 0.96; // per-tick velocity multiplier
const KICK_RANGE = 90;
const KICK_POWER = 520;
// Loose-dribble ball control: how close a player's body has to be to steer
// the ball along with them while running (tighter than KICK_RANGE, which is
// deliberately generous for tapping to kick) - see applyDribbleControl.
const DRIBBLE_RADIUS = PLAYER_R + BALL_R + 10;
// ball speed above which it's "in flight" (a pass/shot just struck) rather
// than something a nearby player can pick up and carry - keeps a kick from
// being instantly re-captured by the kicker's own dribble control
const DRIBBLE_MAX_CONTROL_SPEED = 260;
// how hard the ball's velocity is pulled toward the carrier's each tick -
// low on purpose so the ball has real lag/trail behind the carrier's own
// movement (a loose, bouncy dribble feel) rather than gluing to their feet
const DRIBBLE_BLEND = 0.12;
// carried ball trails very slightly slower than the carrier, so it drifts a
// touch behind on the run instead of tracking their speed exactly
const DRIBBLE_SPEED_FACTOR = 0.92;
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

// every bot plays at one fixed medium-high skill level (no more random
// easy/medium/hard per bot) - fast reactions, tight aim, short cooldown
const BOT_DIFFICULTY = {
  smart: { speed: 178, reactionMs: 260, hesitateChance: 0.06, kickCooldownMs: 1000, wobble: 0.24 },
};
function randomBotDifficulty() {
  return 'smart';
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

// cosmetic-only, client-supplied like name/avatar (no server-side gameplay
// effect) - whitelist keeps it from being used to inject arbitrary values,
// more IDs land here as more auras are added. Kept in sync with profile.js's
// own AURA_IDS (duplicated rather than imported since profile.js doesn't
// export it, same reasoning as JERSEY_IDS below).
const AURA_IDS = ['golden', 'purple', 'green', 'teal', 'orange', 'blue'];
function sanitizeAura(aura) {
  return typeof aura === 'string' && AURA_IDS.includes(aura) ? aura : null;
}

// jersey is visible to every player in the room (unlike pitch/ball, which
// are self-only and never leave the client) - see JERSEY_CHAR_SRC client-side
const JERSEY_IDS = ['golden', 'sky', 'purple', 'tropical', 'frost', 'royal'];
function sanitizeJersey(jersey) {
  return typeof jersey === 'string' && JERSEY_IDS.includes(jersey) ? jersey : null;
}

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoomState(hostSocketId, matchDuration, hostName, teamSize, hostUserId, hostAura, hostJersey) {
  const code = makeRoomCode();
  const size = sanitizeTeamSize(teamSize);
  const slots = getSlots(size);
  const startPos = getStartPos(slots, size);
  const entities = {};
  slots.forEach((slot) => {
    entities[slot] = {
      x: startPos[slot].x, y: startPos[slot].y, vx: 0, vy: 0,
      team: slot[0], isBot: true, socketId: null, name: randomBotName(), userId: null,
      equippedAura: null, equippedJersey: null, difficulty: randomBotDifficulty(), inputVec: { x: 0, y: 0 },
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
    ball: { x: FIELD.w / 2, y: FIELD.h / 2, vx: 0, vy: 0, lastKickSlot: null },
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
  entities.A1.userId = typeof hostUserId === 'string' ? hostUserId : null;
  entities.A1.equippedAura = sanitizeAura(hostAura);
  entities.A1.equippedJersey = sanitizeJersey(hostJersey);
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
    players[slot] = { connected: !room.entities[slot].isBot, name: room.entities[slot].name || 'Player', jersey: room.entities[slot].equippedJersey || null };
  });
  io.to(room.code).emit('lobbyUpdate', { code: room.code, players, hostSlot: room.hostSlot, teamSize: room.teamSize, countdownEndsAt: room.matchmakeCountdownEndsAt || null });
}

// fired once per actual kick (not every tick) so clients can play the
// kicker's equipped aura trail on the ball - only when there's actually an
// aura to show (bots always carry equippedAura: null), so bot kicks (which
// happen just as often as real ones) don't add pointless socket traffic
function emitBallKicked(room, slot) {
  const e = room.entities[slot];
  if (!e || !e.equippedAura) return;
  io.to(room.code).emit('ballKicked', { slot, aura: e.equippedAura });
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

// the sprite's shadow (the visual "feet"/ground-contact point) sits 28px
// below the entity's own y in screen space (see the +28 in ensureEntitySprite
// in www/index.html) - clamping so the SHADOW lands on the touchline (not the
// entity's y, which is the sprite's vertical center) means the feet actually
// touch the line at the TOP, with the head/shoulders above the anchor
// intentionally allowed to overlap the crowd there (the only side this is
// acceptable on, by design).
const SHADOW_OFFSET = 28;
// CHAR_W/CHAR_H halves, mirroring www/index.html's sprite frame size - used
// so the clamp keys off the sprite's own rendered edges (feet/sides), not
// PLAYER_R (the physics collision radius, tuned for player-player/ball
// collision feel, not visual fit) which left a visible gap from the true
// touchline on the sides, and at the BOTTOM edge undershot the sprite's own
// bottom edge (34px below anchor) by 6px versus SHADOW_OFFSET (28px),
// letting the feet visually overflow into the crowd there too - both fixed
// below so every side has the sprite's actual edge land exactly on the line,
// with zero gap and zero overflow, except the top's intentional head/crowd
// overlap.
const SPRITE_HALF_W = 22;
const SPRITE_HALF_H = 34;

function clampToPitch(e) {
  const minX = PITCH.x + SPRITE_HALF_W, maxX = PITCH.x + PITCH.w - SPRITE_HALF_W;
  const minY = PITCH.y - SHADOW_OFFSET, maxY = PITCH.y + PITCH.h - SPRITE_HALF_H;
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

// whichever entity (human or bot) is nearest the ball on each team becomes
// that team's ball chaser for this tick; a team's other BOTS hold a
// supporting position instead of all crowding the ball at once - a human
// nearest the ball puts every bot on that team into support mode
function botAssignRoles(room) {
  const roles = {};
  ['A', 'B'].forEach((team) => {
    const teamSlots = room.slots.filter((s) => room.entities[s].team === team);
    let nearestSlot = null, nearestDist = Infinity;
    teamSlots.forEach((s) => {
      const e = room.entities[s];
      const d = Math.hypot(room.ball.x - e.x, room.ball.y - e.y);
      if (d < nearestDist) { nearestDist = d; nearestSlot = s; }
    });
    teamSlots.forEach((s) => {
      roles[s] = (s === nearestSlot && room.entities[s].isBot) ? 'chase' : 'support';
    });
  });
  return roles;
}

// a loose team shape for bots not currently chasing the ball: keep each
// bot's own lane (their kickoff Y keeps teammates spread across the width
// instead of collapsing onto the ball), but roam much further up/downfield
// and across that lane with the run of play, like a real player shifting
// around the pitch rather than being tethered near a fixed spot
function supportTarget(room, slot) {
  const e = room.entities[slot];
  const home = room.startPos[slot];
  const attackSign = e.team === 'A' ? 1 : -1;
  const advance = clampNum((room.ball.x - FIELD.w / 2) * 0.55 * attackSign, -220, 320);
  return {
    x: clampNum(home.x + advance, PITCH.x + PLAYER_R + 10, PITCH.x + PITCH.w - PLAYER_R - 10),
    y: clampNum(home.y + (room.ball.y - home.y) * 0.55, PITCH.y + PLAYER_R + 10, PITCH.y + PITCH.h - PLAYER_R - 10),
  };
}

// decide what a bot does with the ball once it's in range: shoot if close
// enough to goal, pass to a teammate who's meaningfully further upfield and
// reachable, otherwise nudge the ball forward rather than always blasting a
// full-power shot at goal from anywhere on the pitch
function chooseBotKick(room, slot) {
  const e = room.entities[slot];
  const attackGoalX = e.team === 'A' ? FIELD.w - 20 : 20;
  const goalCenterY = FIELD.h / 2;
  const distToGoal = Math.hypot(attackGoalX - e.x, goalCenterY - e.y);

  let bestPassTarget = null, bestPassScore = -Infinity;
  room.slots.forEach((s) => {
    if (s === slot) return;
    const t = room.entities[s];
    if (t.team !== e.team) return;
    const dist = Math.hypot(t.x - e.x, t.y - e.y);
    if (dist < 60 || dist > 560) return; // too close to bother, or too far to hit cleanly
    const advancement = e.team === 'A' ? (t.x - e.x) : (e.x - t.x); // + = teammate is further upfield
    if (advancement < -120) return; // still fine with a square/build-up pass, just not a clear backward one

    // favor teammates the opposing team isn't already tight on ("open")
    const nearestMarker = room.slots.reduce((min, os) => {
      const o = room.entities[os];
      if (o.team === t.team) return min;
      return Math.min(min, Math.hypot(o.x - t.x, o.y - t.y));
    }, Infinity);
    const opennessBonus = Math.min(nearestMarker, 220);

    const score = advancement - dist * 0.2 + opennessBonus * 0.6;
    if (score > bestPassScore) { bestPassScore = score; bestPassTarget = t; }
  });

  const SHOOT_RANGE = 480, CLEAR_SHOT_RANGE = 160;
  if (distToGoal < SHOOT_RANGE && (!bestPassTarget || distToGoal < CLEAR_SHOT_RANGE)) {
    return { type: 'shoot' };
  }
  if (bestPassTarget) return { type: 'pass', target: bestPassTarget };
  // no clear pass or shot - hold off kicking entirely and let
  // applyDribbleControl carry the ball along as the bot keeps running,
  // same as a human dribbling, rather than tapping it forward itself
  return null;
}

// returns true only when a real pass/shoot kick was struck, so the caller
// knows whether to spend this bot's kick cooldown
function applyBotKick(room, slot, e, cfg) {
  const decision = chooseBotKick(room, slot);
  if (!decision) return false;
  const wobble = (Math.random() - 0.5) * cfg.wobble;

  if (decision.type === 'pass') {
    const t = decision.target;
    // lead the pass toward where the receiver is headed, not just where
    // they are right now
    const leadTime = 0.35;
    const targetX = t.x + t.vx * leadTime;
    const targetY = t.y + t.vy * leadTime;
    const passDist = Math.hypot(targetX - e.x, targetY - e.y);
    const passPower = clampNum(passDist * 1.7, 220, KICK_POWER * 0.85);
    const aimAngle = Math.atan2(targetY - e.y, targetX - e.x) + wobble * 0.5;
    room.ball.vx = Math.cos(aimAngle) * passPower;
    room.ball.vy = Math.sin(aimAngle) * passPower;
  } else {
    const goalX = e.team === 'A' ? FIELD.w - 20 : 20;
    const aimAngle = Math.atan2(FIELD.h / 2 - e.y, goalX - e.x) + wobble;
    room.ball.vx = Math.cos(aimAngle) * KICK_POWER;
    room.ball.vy = Math.sin(aimAngle) * KICK_POWER;
  }
  room.ball.lastKickSlot = slot;
  emitBallKicked(room, slot);
  return true;
}

function updateBots(room, dt) {
  const now = Date.now();
  const roles = botAssignRoles(room);
  room.slots.forEach((slot) => {
    const e = room.entities[slot];
    if (!e.isBot) return;
    const cfg = BOT_DIFFICULTY[e.difficulty] || BOT_DIFFICULTY.smart;
    let bs = room.botState[slot];
    if (!bs) bs = room.botState[slot] = { targetRefresh: 0, target: null, hesitate: false, lastKick: 0 };

    const role = roles[slot];
    let moveTarget, speed;
    if (role === 'chase') {
      // reaction time + hesitation chance both tighten as difficulty increases
      if (now - bs.targetRefresh > cfg.reactionMs) {
        bs.targetRefresh = now;
        bs.target = { x: room.ball.x, y: room.ball.y };
        bs.hesitate = Math.random() < cfg.hesitateChance;
      }
      moveTarget = bs.target || room.ball;
      speed = cfg.speed;
    } else {
      bs.hesitate = false;
      moveTarget = supportTarget(room, slot);
      speed = cfg.speed * 0.8; // holding shape is a jog, not a sprint
    }

    const dx = moveTarget.x - e.x, dy = moveTarget.y - e.y;
    const dist = Math.hypot(dx, dy);

    if (bs.hesitate || dist <= 4) {
      e.vx = 0; e.vy = 0;
    } else {
      e.vx = (dx / dist) * speed;
      e.vy = (dy / dist) * speed;
    }
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    clampToPitch(e);

    const realDist = Math.hypot(room.ball.x - e.x, room.ball.y - e.y);
    // only a real pass/shoot decision consumes the cooldown - advancing the
    // ball the rest of the time is just applyDribbleControl steering it
    // along as the bot runs, same as a human dribbling
    if (!room.resetting && realDist < KICK_RANGE && now - bs.lastKick > cfg.kickCooldownMs) {
      if (applyBotKick(room, slot, e, cfg)) bs.lastKick = now;
    }
  });
}

// Loose-dribble ball control: whichever player's body is closest within
// DRIBBLE_RADIUS steers the ball's velocity toward their own each tick
// (scaled down and blended gradually so it trails behind rather than
// gluing to their feet). Possession isn't tracked as separate state - it's
// just "nearest player right now", recomputed fresh every tick - so a
// defender who gets closer than the current carrier naturally takes it over
// on their very next tick with no extra steal logic needed. Only engages
// below DRIBBLE_MAX_CONTROL_SPEED so it never fights an in-flight pass/shot;
// that has to slow down (or be closely received) before anyone can carry it.
function applyDribbleControl(room) {
  const b = room.ball;
  if (Math.hypot(b.vx, b.vy) > DRIBBLE_MAX_CONTROL_SPEED) return;

  let carrier = null, carrierDist = DRIBBLE_RADIUS;
  room.slots.forEach((slot) => {
    const e = room.entities[slot];
    const dist = Math.hypot(b.x - e.x, b.y - e.y);
    if (dist < carrierDist) { carrierDist = dist; carrier = e; }
  });
  if (!carrier) return;

  b.vx += (carrier.vx * DRIBBLE_SPEED_FACTOR - b.vx) * DRIBBLE_BLEND;
  b.vy += (carrier.vy * DRIBBLE_SPEED_FACTOR - b.vy) * DRIBBLE_BLEND;
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

  clampBallBounds(room);
}

// pulled out of updateBall so it can also run after resolveCollisions - a
// player-ball push there was moving the ball past the goal frame (into the
// crowd/stand area) without ever being clamped back, since it only got
// caught on the FOLLOWING tick's updateBall call at the earliest
function clampBallBounds(room) {
  const b = room.ball;
  const minY = PITCH.y + BALL_R, maxY = PITCH.y + PITCH.h - BALL_R;
  if (b.y < minY) { b.y = minY; b.vy *= -0.6; }
  if (b.y > maxY) { b.y = maxY; b.vy *= -0.6; }

  const goalY0 = FIELD.h / 2 - GOAL_WIDTH / 2, goalY1 = FIELD.h / 2 + GOAL_WIDTH / 2;
  const inMouth = b.y >= goalY0 && b.y <= goalY1;
  const minX = PITCH.x + BALL_R, maxX = PITCH.x + PITCH.w - BALL_R;

  if (b.x < minX) {
    // the net has a real, finite depth in the field art - NET_MIN_X/NET_MAX_X
    // mark where its back wall actually is, so the ball stops inside the net
    // instead of sailing past it into the crowd
    if (inMouth) { if (b.x < NET_MIN_X) { b.x = NET_MIN_X; b.vx *= -0.4; } }
    else { b.x = minX; b.vx *= -0.6; }
  }
  if (b.x > maxX) {
    if (inMouth) { if (b.x > NET_MAX_X) { b.x = NET_MAX_X; b.vx *= -0.4; } }
    else { b.x = maxX; b.vx *= -0.6; }
  }

  // hard failsafe: regardless of the goal-mouth exception above, the ball
  // should never end up meaningfully outside the pitch + net pockets
  b.x = clampNum(b.x, NET_MIN_X, NET_MAX_X);
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
      clampBallBounds(room);
    }
  });
}

function checkGoals(room) {
  if (room.resetting || room.ended) return;
  const b = room.ball;
  const goalY0 = FIELD.h / 2 - GOAL_WIDTH / 2, goalY1 = FIELD.h / 2 + GOAL_WIDTH / 2;
  if (b.y < goalY0 || b.y > goalY1) return;
  // NET_MIN_X/NET_MAX_X is as deep into the net as the ball can physically
  // get (clampBallBounds stops it there) - these were previously a flat
  // 4 / FIELD.w-4 that clampBallBounds' tighter net bounds could no longer
  // reach, so a goal could never actually fire
  if (b.x <= NET_MIN_X) scoreGoal(room, 'B');       // ball crossed A's line -> B scores
  else if (b.x >= NET_MAX_X) scoreGoal(room, 'A'); // ball crossed B's line -> A scores
}

function scoreGoal(room, team) {
  room.resetting = true;
  room.score[team]++;

  // attribute the goal to whoever last kicked it, as long as that's a real
  // player on the scoring team (an own-goal's kicker is on the OTHER team,
  // so this naturally excludes those from getting credit)
  const kickerSlot = room.ball.lastKickSlot;
  const kicker = kickerSlot && room.entities[kickerSlot];
  if (kicker && !kicker.isBot && kicker.userId && kicker.team === team) {
    profile.incrementStats(kicker.userId, { goals: 1 }).catch(() => {});
  }

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

  const winner = room.score.A === room.score.B ? null : (room.score.A > room.score.B ? 'A' : 'B');
  room.slots.forEach((slot) => {
    const e = room.entities[slot];
    if (e.isBot || !e.userId) return;
    profile.incrementStats(e.userId, { played: 1, won: e.team === winner ? 1 : 0 }).catch(() => {});
  });
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
    applyDribbleControl(room);
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
    const hostUserId = typeof (data && data.userId) === 'string' ? data.userId : null;
    const room = createRoomState(socket.id, matchDuration, data && data.name, data && data.teamSize, hostUserId, data && data.equippedAura, data && data.equippedJersey);
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
    room.entities[slot].userId = typeof (data && data.userId) === 'string' ? data.userId : null;
    room.entities[slot].equippedAura = sanitizeAura(data && data.equippedAura);
    room.entities[slot].equippedJersey = sanitizeJersey(data && data.equippedJersey);
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
      existing.entities[slot].userId = typeof (data && data.userId) === 'string' ? data.userId : null;
      existing.entities[slot].equippedAura = sanitizeAura(data && data.equippedAura);
      existing.entities[slot].equippedJersey = sanitizeJersey(data && data.equippedJersey);
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
    const hostUserId = typeof (data && data.userId) === 'string' ? data.userId : null;
    const room = createRoomState(socket.id, matchDuration, data && data.name, teamSize, hostUserId, data && data.equippedAura, data && data.equippedJersey);
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
      room.ball.lastKickSlot = socket.data.slot;
      emitBallKicked(room, socket.data.slot);
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
      equippedAura: data && data.equippedAura,
      equippedPitch: data && data.equippedPitch,
      equippedBall: data && data.equippedBall,
      equippedJersey: data && data.equippedJersey,
    }));
  });

  // re-fetches current stats (matches played/won, goals) without a full
  // login round-trip - called each time the Profile screen opens, since the
  // cached profile from login can be stale after playing more matches
  socket.on('getProfileStats', async (data, cb) => {
    if (typeof cb !== 'function') return;
    cb(await profile.getStats(data && data.userId));
  });

  // current week's live top 50 + the caller's own rank, last week's frozen
  // top-3 winners for the podium, and when the current week ends
  socket.on('getLeaderboard', async (data, cb) => {
    if (typeof cb !== 'function') return;
    cb(await profile.getLeaderboard(data && data.userId));
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
