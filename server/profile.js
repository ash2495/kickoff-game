// ============================================================
// KICKOFF DUEL — player profile logic: Guest/Google login,
// profile edits. All three exported functions return a plain
// { ok, ... } / { ok:false, error } shape, matching the ack-
// callback convention every socket handler in server.js already
// uses.
// ============================================================

const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { OAuth2Client } = require('google-auth-library');
const { getUsers, getMeta } = require('./db');

const GOOGLE_WEB_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID;
const SESSION_SECRET = process.env.SESSION_SECRET;
const googleClient = GOOGLE_WEB_CLIENT_ID ? new OAuth2Client(GOOGLE_WEB_CLIENT_ID) : null;

// avatars are a fixed set of in-game presets (www/assets/avatar_preset_NN.png)
// selected by ID - no user-uploaded images, so no image data to validate or store
const AVATAR_PRESET_COUNT = 6;

// one-time bonus granted only when a user doc is first created (guest or
// Google, whichever happens first) - never re-granted on later logins, since
// it's only ever set on the `insert` object below, not on an existing doc
const SIGNUP_BONUS_COINS = 10000;

function sanitizeName(name) {
  if (typeof name !== 'string') return 'Player';
  const trimmed = name.trim().slice(0, 16);
  return trimmed || 'Player';
}

function sanitizeCountry(country) {
  if (typeof country !== 'string') return null;
  const code = country.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function sanitizeAvatar(avatar) {
  if (avatar === null) return null;
  if (typeof avatar !== 'string') return undefined; // undefined = "leave unchanged"
  const m = /^avatar_preset_(\d{2})$/.exec(avatar);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > AVATAR_PRESET_COUNT) return undefined;
  return avatar;
}

// Shop cosmetic (ball trail on kick) - free to equip for now, no
// currency/unlock gating. More IDs land here as more auras are added.
const AURA_IDS = ['golden', 'purple', 'green', 'teal', 'orange', 'blue'];
function sanitizeAura(aura) {
  if (aura === null) return null;
  if (typeof aura !== 'string') return undefined; // undefined = "leave unchanged"
  return AURA_IDS.includes(aura) ? aura : undefined;
}

// Shop cosmetic (pitch/stadium skin) - purely a local rendering choice for
// whoever equips it (never sent to opponents, unlike equippedAura), so no
// room/match plumbing needed - just persisted here and read back by the
// client that owns it.
const PITCH_IDS = ['classic', 'beach', 'rainy', 'winter', 'volcano', 'halloween'];
function sanitizePitch(pitch) {
  if (pitch === null) return null;
  if (typeof pitch !== 'string') return undefined; // undefined = "leave unchanged"
  return PITCH_IDS.includes(pitch) ? pitch : undefined;
}

// Shop cosmetic (ball skin) - persisted the same way as equippedPitch for
// now. Unlike a pitch/character skin, the ball is a single object every
// player in a match interacts with, so treating this as self-only (like
// equippedPitch) rather than synced-to-everyone (like equippedAura) is a
// real product question, not yet settled - see the client-side TODO on
// PROFILE_EQUIPPED_BALL. Storing the choice here either way is harmless.
const BALL_IDS = ['beach', 'pumpkin', 'ice', 'lava', 'thunder', 'ghost'];
function sanitizeBall(ball) {
  if (ball === null) return null;
  if (typeof ball !== 'string') return undefined; // undefined = "leave unchanged"
  return BALL_IDS.includes(ball) ? ball : undefined;
}

// Shop cosmetic (jersey skin) - visible to everyone in the match (unlike
// equippedPitch/equippedBall, which are self-only) - a real character
// reskin, see JERSEY_CHAR_SRC client-side.
const JERSEY_IDS = ['golden', 'sky', 'purple', 'tropical', 'frost', 'royal'];
function sanitizeJersey(jersey) {
  if (jersey === null) return null;
  if (typeof jersey !== 'string') return undefined; // undefined = "leave unchanged"
  return JERSEY_IDS.includes(jersey) ? jersey : undefined;
}

function issueToken(userId) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(userId).digest('hex');
}

function verifyToken(userId, token) {
  if (typeof token !== 'string') return false;
  const expected = issueToken(userId);
  // constant-time compare - both sides are always same-length hex digests
  return expected.length === token.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

async function toPublicProfile(doc) {
  const matchesPlayed = doc.matchesPlayed || 0;
  const matchesWon = doc.matchesWon || 0;
  const userId = doc._id.toString();
  return {
    userId,
    name: doc.name,
    country: doc.country,
    avatar: doc.avatar,
    equippedAura: doc.equippedAura || null,
    equippedPitch: doc.equippedPitch || null,
    equippedBall: doc.equippedBall || null,
    equippedJersey: doc.equippedJersey || null,
    hasGoogle: !!doc.googleId,
    matchesPlayed,
    matchesWon,
    goalsScored: doc.goalsScored || 0,
    winRate: matchesPlayed > 0 ? Math.round((matchesWon / matchesPlayed) * 100) : 0,
    frameRank: await getFrameRank(userId),
    coins: doc.coins || 0,
  };
}

async function guestLogin(deviceId) {
  if (typeof deviceId !== 'string' || !deviceId) return { ok: false, error: 'Missing device ID.' };
  const users = getUsers();
  const now = new Date();

  let doc = await users.findOneAndUpdate(
    { deviceIds: deviceId },
    { $set: { lastSeenAt: now } },
    { returnDocument: 'after' }
  );
  if (!doc) {
    // deliberately no `googleId` key at all (not even `null`) - the sparse
    // unique index on googleId only excludes documents where the field is
    // fully ABSENT, not ones where it's explicitly null, so an explicit
    // null on every guest doc would collide on the very first second guest
    const insert = {
      deviceIds: [deviceId],
      name: 'Player',
      country: null,
      avatar: null,
      createdAt: now,
      lastSeenAt: now,
      coins: SIGNUP_BONUS_COINS,
    };
    const result = await users.insertOne(insert);
    doc = { ...insert, _id: result.insertedId };
  }

  return { ok: true, ...(await toPublicProfile(doc)), authToken: issueToken(doc._id.toString()) };
}

async function googleLogin(idToken, deviceId) {
  if (!googleClient) return { ok: false, error: 'Google Sign-In is not configured on the server yet.' };
  if (typeof deviceId !== 'string' || !deviceId) return { ok: false, error: 'Missing device ID.' };

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_WEB_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (e) {
    return { ok: false, error: 'Could not verify Google sign-in.' };
  }
  if (!payload || !payload.sub) return { ok: false, error: 'Could not verify Google sign-in.' };

  const users = getUsers();
  const now = new Date();
  const googleId = payload.sub;

  // look up by googleId FIRST - if this Google account already has a
  // profile, never let a stale local guest doc for this device clobber it
  let doc = await users.findOneAndUpdate(
    { googleId },
    { $addToSet: { deviceIds: deviceId }, $set: { lastSeenAt: now } },
    { returnDocument: 'after' }
  );

  if (!doc) {
    // no account for this Google identity yet - promote a matching guest
    // doc for this device if one exists, otherwise create fresh
    const guestDoc = await users.findOne({ deviceIds: deviceId, googleId: null });
    if (guestDoc) {
      const set = { googleId, lastSeenAt: now };
      // only import Google's name as a convenience default if the player
      // never customized their guest name - don't clobber an edited one
      if (guestDoc.name === 'Player' && payload.name) set.name = sanitizeName(payload.name);
      await users.updateOne({ _id: guestDoc._id }, { $set: set });
      doc = { ...guestDoc, ...set };
    } else {
      const insert = {
        deviceIds: [deviceId],
        googleId,
        name: sanitizeName(payload.name || 'Player'),
        country: null,
        avatar: null,
        createdAt: now,
        lastSeenAt: now,
        coins: SIGNUP_BONUS_COINS,
      };
      const result = await users.insertOne(insert);
      doc = { ...insert, _id: result.insertedId };
    }
  }

  return { ok: true, ...(await toPublicProfile(doc)), authToken: issueToken(doc._id.toString()) };
}

async function updateProfile(userId, authToken, { name, country, avatar, equippedAura, equippedPitch, equippedBall, equippedJersey } = {}) {
  if (typeof userId !== 'string' || !ObjectId.isValid(userId)) return { ok: false, error: 'Invalid profile.' };
  if (!verifyToken(userId, authToken)) return { ok: false, error: 'Not authorized.' };

  const set = { lastSeenAt: new Date() };
  if (name !== undefined) set.name = sanitizeName(name);
  if (country !== undefined) set.country = sanitizeCountry(country);
  if (avatar !== undefined) {
    const cleanAvatar = sanitizeAvatar(avatar);
    if (cleanAvatar !== undefined) set.avatar = cleanAvatar;
  }
  if (equippedAura !== undefined) {
    const cleanAura = sanitizeAura(equippedAura);
    if (cleanAura !== undefined) set.equippedAura = cleanAura;
  }
  if (equippedPitch !== undefined) {
    const cleanPitch = sanitizePitch(equippedPitch);
    if (cleanPitch !== undefined) set.equippedPitch = cleanPitch;
  }
  if (equippedBall !== undefined) {
    const cleanBall = sanitizeBall(equippedBall);
    if (cleanBall !== undefined) set.equippedBall = cleanBall;
  }
  if (equippedJersey !== undefined) {
    const cleanJersey = sanitizeJersey(equippedJersey);
    if (cleanJersey !== undefined) set.equippedJersey = cleanJersey;
  }

  const users = getUsers();
  const doc = await users.findOneAndUpdate(
    { _id: new ObjectId(userId) },
    { $set: set },
    { returnDocument: 'after' }
  );
  if (!doc) return { ok: false, error: 'Profile not found.' };

  return { ok: true, ...(await toPublicProfile(doc)) };
}

async function getStats(userId) {
  if (typeof userId !== 'string' || !ObjectId.isValid(userId)) return { ok: false, error: 'Invalid profile.' };
  const users = getUsers();
  const doc = await users.findOne({ _id: new ObjectId(userId) });
  if (!doc) return { ok: false, error: 'Profile not found.' };
  return { ok: true, ...(await toPublicProfile(doc)) };
}

// Bet Match stake handling - deductCoins is the only place real currency
// actually leaves an account, so unlike incrementStats (server-trusted,
// no client request behind it) this requires the same authToken check as
// updateProfile. The filter's `coins: {$gte: amount}` makes the deduction
// atomic against a double-spend (e.g. spamming the bet button before the
// first ack returns) - if the balance is too low the findOneAndUpdate
// simply matches nothing rather than a separate read-then-write race.
async function deductCoins(userId, authToken, amount) {
  if (typeof userId !== 'string' || !ObjectId.isValid(userId)) return { ok: false, error: 'Invalid profile.' };
  if (!verifyToken(userId, authToken)) return { ok: false, error: 'Not authorized.' };
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: 'Invalid amount.' };
  const users = getUsers();
  const doc = await users.findOneAndUpdate(
    { _id: new ObjectId(userId), coins: { $gte: amount } },
    { $inc: { coins: -amount } },
    { returnDocument: 'after' }
  );
  if (!doc) return { ok: false, error: 'Not enough coins.' };
  return { ok: true, coins: doc.coins };
}

// credits (stake refund on a draw/early leave, or a Bet Match win payout) -
// server-initiated from room state server.js already trusts (the same
// e.userId incrementStats uses), so no token check needed here
async function creditCoins(userId, amount) {
  if (typeof userId !== 'string' || !ObjectId.isValid(userId) || !Number.isInteger(amount) || amount <= 0) return;
  const users = getUsers();
  await users.updateOne({ _id: new ObjectId(userId) }, { $inc: { coins: amount } });
}

// called from server.js at match end (matchesPlayed/matchesWon for every
// real player) and on each goal (goalsScored for whoever last kicked it) -
// fire-and-forget from the caller's perspective, no ack needed
async function incrementStats(userId, { played = 0, won = 0, goals = 0 } = {}) {
  if (typeof userId !== 'string' || !ObjectId.isValid(userId)) return;
  const inc = {};
  if (played) inc.matchesPlayed = played;
  if (won) inc.matchesWon = won;
  if (goals) inc.goalsScored = goals;
  const users = getUsers();
  if (Object.keys(inc).length > 0) {
    await users.updateOne({ _id: new ObjectId(userId) }, { $inc: inc });
  }
  if (goals) {
    // make sure last week's winners get snapshotted BEFORE this write can
    // roll this user's own weeklyGoals over into the new week and erase
    // their contribution to the week that just ended
    await ensureWeekRollover();
    const currentWeekId = getWeekId();
    // aggregation-pipeline update: atomically reset-then-add in one op if
    // the stored weekId is stale, otherwise just add - avoids a separate
    // read-modify-write race between concurrent goals for the same scorer
    await users.updateOne({ _id: new ObjectId(userId) }, [{
      $set: {
        weeklyGoals: {
          $cond: [
            { $eq: ['$weeklyGoals.weekId', currentWeekId] },
            { weekId: currentWeekId, count: { $add: [{ $ifNull: ['$weeklyGoals.count', 0] }, goals] } },
            { weekId: currentWeekId, count: goals },
          ],
        },
      },
    }]);
  }
}

// ---- Weekly leaderboard ----
// week boundaries are a fixed 7-day cycle from an arbitrary Monday epoch,
// not a calendar ISO week - avoids calendar/timezone edge cases, all that
// matters is every server process agrees on the same boundaries
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEK_EPOCH = Date.UTC(2024, 0, 1);

function getWeekId(date = new Date()) {
  return Math.floor((date.getTime() - WEEK_EPOCH) / WEEK_MS);
}
function weekEndsAt(weekId) {
  return WEEK_EPOCH + (weekId + 1) * WEEK_MS;
}

// if the week has rolled over since the last time anyone checked, snapshot
// the top 3 from the week that just ended into the meta doc before anything
// else can reset their weeklyGoals counters for the new week. Cheap no-op
// read on every other call. Not perfectly race-free if literally nobody
// scores or opens the leaderboard for multiple whole weeks in a row (the
// in-between week's data is only ever kept in each user's own doc, not a
// full history), but for an actively-played game this is a fine tradeoff.
async function ensureWeekRollover() {
  const currentWeekId = getWeekId();
  const meta = getMeta();
  const doc = await meta.findOne({ _id: 'leaderboard' });
  if (!doc) {
    await meta.updateOne(
      { _id: 'leaderboard' },
      { $set: { lastSnapshotWeekId: currentWeekId, lastWeekWinners: [] } },
      { upsert: true }
    );
    return [];
  }
  if (doc.lastSnapshotWeekId >= currentWeekId) return doc.lastWeekWinners || [];

  const users = getUsers();
  const top3 = await users.find({ 'weeklyGoals.weekId': doc.lastSnapshotWeekId, 'weeklyGoals.count': { $gt: 0 } })
    .sort({ 'weeklyGoals.count': -1 })
    .limit(3)
    .toArray();
  const winners = top3.map((u, i) => ({
    userId: u._id.toString(), name: u.name, avatar: u.avatar, goals: u.weeklyGoals.count, rank: i + 1,
  }));
  await meta.updateOne(
    { _id: 'leaderboard' },
    { $set: { lastSnapshotWeekId: currentWeekId, lastWeekWinners: winners } }
  );
  return winners;
}

// current reward-frame rank (1/2/3) for a single user, or null - looked up
// fresh from the same snapshot ensureWeekRollover maintains rather than
// cached on the user doc, so it naturally disappears the moment the
// snapshot rolls over with zero extra bookkeeping. Used to decorate this
// user's avatar wherever it's rendered (profile pill, matchmaking, profile
// screen) - see toPublicProfile above.
async function getFrameRank(userId) {
  const winners = await ensureWeekRollover();
  const entry = winners.find((w) => w.userId === userId);
  return entry ? entry.rank : null;
}

// top 50 for the CURRENT (still live) week, the requesting user's own rank
// even if outside the top 50, and last week's frozen top-3 winners for the
// podium (see ensureWeekRollover)
async function getLeaderboard(userId) {
  const lastWeekWinners = await ensureWeekRollover();
  const frameByUser = new Map(lastWeekWinners.map((w) => [w.userId, w.rank]));
  const currentWeekId = getWeekId();
  const users = getUsers();
  const active = await users.find({ 'weeklyGoals.weekId': currentWeekId })
    .sort({ 'weeklyGoals.count': -1 })
    .limit(50)
    .toArray();

  const top = active.slice(0, 50).map((u, i) => ({
    userId: u._id.toString(), name: u.name, avatar: u.avatar, goals: u.weeklyGoals.count, rank: i + 1,
    frameRank: frameByUser.get(u._id.toString()) || null,
  }));

  let me = null;
  if (typeof userId === 'string' && ObjectId.isValid(userId)) {
    const idx = active.findIndex((u) => u._id.toString() === userId);
    if (idx >= 0) {
      me = { userId, name: active[idx].name, avatar: active[idx].avatar, goals: active[idx].weeklyGoals.count, rank: idx + 1, frameRank: frameByUser.get(userId) || null };
    } else {
      const doc = await users.findOne({ _id: new ObjectId(userId) });
      if (doc) {
        const goals = (doc.weeklyGoals && doc.weeklyGoals.weekId === currentWeekId) ? doc.weeklyGoals.count : 0;
        me = { userId, name: doc.name, avatar: doc.avatar, goals, rank: null, frameRank: frameByUser.get(userId) || null };
      }
    }
  }

  return { ok: true, top, me, lastWeekWinners, weekEndsAt: weekEndsAt(currentWeekId) };
}

module.exports = { guestLogin, googleLogin, updateProfile, getStats, incrementStats, getLeaderboard, deductCoins, creditCoins };
