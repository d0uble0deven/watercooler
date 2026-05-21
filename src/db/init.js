'use strict';

// Creates all Watercooler tables (if they don't already exist) and seeds the
// one required settings row on first run.
//
// Safe to call every time the app starts — CREATE IF NOT EXISTS is idempotent.

const { getDb }  = require('./connection');
const config     = require('../config');

// ── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA = `

  -- Participants who have opted in (or previously opted in) to Watercooler
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slack_user_id TEXT    NOT NULL UNIQUE,
    display_name  TEXT    NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,  -- 0 = left
    is_paused     INTEGER NOT NULL DEFAULT 0,  -- 1 = temporarily excluded from matching
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Single row of app-wide configuration
  CREATE TABLE IF NOT EXISTS settings (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    intro_channel_id    TEXT,                             -- Slack channel ID for announcements
    group_size          INTEGER NOT NULL DEFAULT 2,       -- 2 = pairs, 3 would be all trios
    avoid_repeat_rounds INTEGER NOT NULL DEFAULT 4,       -- avoid repeating a pair within N rounds
    cadence             TEXT    NOT NULL DEFAULT 'weekly', -- 'weekly' | 'biweekly' | 'monthly'
    intro_day           TEXT    NOT NULL DEFAULT 'monday',
    intro_time          TEXT    NOT NULL DEFAULT '09:00',
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- A single matching run (one batch of pairs created together)
  CREATE TABLE IF NOT EXISTS rounds (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    status       TEXT    NOT NULL DEFAULT 'pending',  -- 'pending' | 'completed' | 'dry_run'
    started_at   TEXT,
    completed_at TEXT,
    created_by   TEXT,                                -- Slack user ID of whoever triggered the run
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- One group (pair or trio) within a round
  CREATE TABLE IF NOT EXISTS matches (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id            INTEGER NOT NULL,
    slack_dm_channel_id TEXT,                         -- filled in after the DM is created
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (round_id) REFERENCES rounds(id)
  );

  -- Members of each match (links matches ↔ users)
  CREATE TABLE IF NOT EXISTS match_members (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL,
    user_id  INTEGER NOT NULL,
    FOREIGN KEY (match_id) REFERENCES matches(id),
    FOREIGN KEY (user_id)  REFERENCES users(id)
  );

  -- History of every pairing — used to avoid repeats.
  -- IMPORTANT: we always store user_a_id < user_b_id (enforced in code)
  -- so a pair (Alice, Bob) is never stored twice as (Bob, Alice).
  CREATE TABLE IF NOT EXISTS pair_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a_id  INTEGER NOT NULL,
    user_b_id  INTEGER NOT NULL,
    round_id   INTEGER NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_a_id) REFERENCES users(id),
    FOREIGN KEY (user_b_id) REFERENCES users(id),
    FOREIGN KEY (round_id)  REFERENCES rounds(id)
  );

  -- Users permanently excluded from matching (admin-managed)
  CREATE TABLE IF NOT EXISTS exclusions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slack_user_id TEXT NOT NULL UNIQUE,
    reason        TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    created_by    TEXT
  );

  -- Speed up the most common queries
  CREATE INDEX IF NOT EXISTS idx_pair_history_users
    ON pair_history (user_a_id, user_b_id);

  CREATE INDEX IF NOT EXISTS idx_match_members_user
    ON match_members (user_id);

`;

// ── Migrations ────────────────────────────────────────────────────────────────
// ALTER TABLE can't use IF NOT EXISTS, so we attempt each column and swallow
// the "duplicate column name" error that SQLite throws when it already exists.

const MIGRATIONS = [
  `ALTER TABLE settings ADD COLUMN calendar_enabled  INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE settings ADD COLUMN meeting_duration  INTEGER NOT NULL DEFAULT 30`,
  `ALTER TABLE settings ADD COLUMN booking_deadline  REAL    NOT NULL DEFAULT 2.5`,
];

function runMigrations(db) {
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (err) {
      // "duplicate column name" is expected when running on an existing DB
      if (!err.message.includes('duplicate column name')) throw err;
    }
  }
}

// ── Init function ─────────────────────────────────────────────────────────────

function initDb() {
  const db = getDb();

  db.exec(SCHEMA);
  runMigrations(db);

  // There should always be exactly one settings row.
  // Seed it on first init with sensible defaults.
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM settings').get();
  if (count === 0) {
    db.prepare(`
      INSERT INTO settings (group_size, avoid_repeat_rounds, cadence, intro_day, intro_time,
                            calendar_enabled, meeting_duration, booking_deadline)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(2, 4, 'weekly', 'monday', '09:00', 0, 30, 2.5);
    console.log('  → Default settings row created');
  }

  console.log('✅ Database ready:', config.databasePath);
}

module.exports = { initDb };
