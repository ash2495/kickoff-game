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
const { getUsers } = require('./db');

const GOOGLE_WEB_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID;
const SESSION_SECRET = process.env.SESSION_SECRET;
const googleClient = GOOGLE_WEB_CLIENT_ID ? new OAuth2Client(GOOGLE_WEB_CLIENT_ID) : null;

// avatars are a fixed set of in-game presets (www/assets/avatar_preset_NN.png)
// selected by ID - no user-uploaded images, so no image data to validate or store
const AVATAR_PRESET_COUNT = 5;

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

function toPublicProfile(doc) {
  return {
    userId: doc._id.toString(),
    name: doc.name,
    country: doc.country,
    avatar: doc.avatar,
    hasGoogle: !!doc.googleId,
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
    };
    const result = await users.insertOne(insert);
    doc = { ...insert, _id: result.insertedId };
  }

  return { ok: true, ...toPublicProfile(doc), authToken: issueToken(doc._id.toString()) };
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
      };
      const result = await users.insertOne(insert);
      doc = { ...insert, _id: result.insertedId };
    }
  }

  return { ok: true, ...toPublicProfile(doc), authToken: issueToken(doc._id.toString()) };
}

async function updateProfile(userId, authToken, { name, country, avatar } = {}) {
  if (typeof userId !== 'string' || !ObjectId.isValid(userId)) return { ok: false, error: 'Invalid profile.' };
  if (!verifyToken(userId, authToken)) return { ok: false, error: 'Not authorized.' };

  const set = { lastSeenAt: new Date() };
  if (name !== undefined) set.name = sanitizeName(name);
  if (country !== undefined) set.country = sanitizeCountry(country);
  if (avatar !== undefined) {
    const cleanAvatar = sanitizeAvatar(avatar);
    if (cleanAvatar !== undefined) set.avatar = cleanAvatar;
  }

  const users = getUsers();
  const doc = await users.findOneAndUpdate(
    { _id: new ObjectId(userId) },
    { $set: set },
    { returnDocument: 'after' }
  );
  if (!doc) return { ok: false, error: 'Profile not found.' };

  return { ok: true, ...toPublicProfile(doc) };
}

module.exports = { guestLogin, googleLogin, updateProfile };
