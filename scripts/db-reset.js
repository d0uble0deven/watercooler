'use strict';

// Standalone script: drop ALL tables then recreate from scratch.
// Usage:  npm run db:reset
//
// ⚠️  WARNING — this DELETES ALL DATA.
// Intended for local development only.
// Blocked when NODE_ENV=production.

if (process.env.NODE_ENV === 'production') {
  console.error('❌  db:reset is not allowed in production. Aborting.');
  process.exit(1);
}

const { getDb }  = require('../src/db/connection');
const { initDb } = require('../src/db/init');

console.log('⚠️  Resetting database — all data will be deleted...\n');

const db = getDb();

// Drop tables in reverse-dependency order so foreign-key constraints don't
// complain (even though we turn off FK enforcement temporarily below).
db.exec(`
  PRAGMA foreign_keys = OFF;

  DROP TABLE IF EXISTS exclusions;
  DROP TABLE IF EXISTS pair_history;
  DROP TABLE IF EXISTS match_members;
  DROP TABLE IF EXISTS matches;
  DROP TABLE IF EXISTS rounds;
  DROP TABLE IF EXISTS settings;
  DROP TABLE IF EXISTS users;

  PRAGMA foreign_keys = ON;
`);

console.log('  → All tables dropped');

initDb();

console.log('\n✅ Database reset complete');
