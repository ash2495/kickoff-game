// ============================================================
// KICKOFF DUEL — MongoDB connection for player profiles.
// Guest/Google login and profile edits (server/profile.js) read
// and write through the single `users` collection exported here.
// ============================================================

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  throw new Error('MONGODB_URI env var is required (see server/.env.example).');
}

const client = new MongoClient(MONGODB_URI);
let usersCollection = null;
let metaCollection = null;

async function connectDb() {
  await client.connect();
  const db = client.db();
  usersCollection = db.collection('users');
  // sparse: googleId is absent for guest-only accounts, so this must not
  // enforce uniqueness across many `null`/missing values
  await usersCollection.createIndex({ googleId: 1 }, { unique: true, sparse: true });
  await usersCollection.createIndex({ deviceIds: 1 });
  // small collection of singleton documents for cross-request server state
  // (currently just the weekly leaderboard rollover marker/snapshot)
  metaCollection = db.collection('meta');
  console.log('Connected to MongoDB');
  return usersCollection;
}

function getUsers() {
  if (!usersCollection) throw new Error('MongoDB not connected yet - call connectDb() first.');
  return usersCollection;
}

function getMeta() {
  if (!metaCollection) throw new Error('MongoDB not connected yet - call connectDb() first.');
  return metaCollection;
}

module.exports = { connectDb, getUsers, getMeta };
