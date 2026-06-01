'use strict';

// Phase 11 Step 1 — Post-meeting DB schema tests
//
// Verifies:
//   • All 5 new columns exist on the correct tables
//   • saveMeetingTimes() writes and reads back correctly
//   • completion_fallback_days default is 12
//   • Existing saveBooking() still works (no regression)
//
// No Azure credentials or Slack tokens required.
// Run: npm run test:post1

process.env.ADMIN_USER_IDS = 'UADMIN0';
process.env.DATABASE_PATH  = './data/test-post1.db';

const fs = require('node:fs');
fs.mkdirSync('./data', { recursive: true });
const dbPath = process.env.DATABASE_PATH;
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const { initDb }          = require('../src/db/init');
const { getDb }           = require('../src/db/connection');
const { saveMeetingTimes, saveBooking, getMatch } = require('../src/lib/rounds');

let passed = 0;
let failed = 0;

function check(label, condition, actual) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    if (actual !== undefined) console.error(`     Got: ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log('\n=== Phase 11 — Step 1: Post-Meeting DB Schema Tests ===\n');

initDb();
const db = getDb();

// ── Seed minimal data ─────────────────────────────────────────────────────────
db.prepare(`INSERT INTO rounds (status, started_at, completed_at, created_by) VALUES ('completed', datetime('now'), datetime('now'), 'test')`).run();
const roundId = db.prepare(`SELECT last_insert_rowid() AS id`).get().id;

db.prepare(`INSERT INTO matches (round_id, slack_dm_channel_id) VALUES (?, 'C_TEST')`).run(roundId);
const matchId = db.prepare(`SELECT last_insert_rowid() AS id`).get().id;

// ── matches table: new columns exist ─────────────────────────────────────────
console.log('New columns on matches table');
{
  let threw = false;
  try {
    db.prepare(`UPDATE matches SET meeting_start_at = NULL WHERE id = ?`).run(matchId);
    db.prepare(`UPDATE matches SET meeting_end_at = NULL WHERE id = ?`).run(matchId);
    db.prepare(`UPDATE matches SET feedback = NULL WHERE id = ?`).run(matchId);
    db.prepare(`UPDATE matches SET completion_message_sent = 0 WHERE id = ?`).run(matchId);
  } catch (_) { threw = true; }
  check('meeting_start_at column exists',        !threw);
  check('meeting_end_at column exists',          !threw);
  check('feedback column exists',                !threw);
  check('completion_message_sent column exists', !threw);
}

// ── completion_message_sent default is 0 ─────────────────────────────────────
{
  const row = db.prepare(`SELECT completion_message_sent FROM matches WHERE id = ?`).get(matchId);
  check('completion_message_sent defaults to 0', row?.completion_message_sent === 0, row?.completion_message_sent);
}

// ── settings table: completion_fallback_days ──────────────────────────────────
console.log('\nNew column on settings table');
{
  const row = db.prepare(`SELECT completion_fallback_days FROM settings LIMIT 1`).get();
  check('completion_fallback_days column exists', row !== undefined);
  check('completion_fallback_days defaults to 12', row?.completion_fallback_days === 12, row?.completion_fallback_days);
}

// ── saveMeetingTimes() ────────────────────────────────────────────────────────
console.log('\nsaveMeetingTimes()');
{
  const start = new Date('2026-06-09T13:00:00.000Z'); // 9 AM ET
  const end   = new Date('2026-06-09T13:15:00.000Z'); // 9:15 AM ET

  saveMeetingTimes(matchId, start, end);

  const row = db.prepare(`SELECT meeting_start_at, meeting_end_at FROM matches WHERE id = ?`).get(matchId);
  check('meeting_start_at is stored',           row?.meeting_start_at === start.toISOString(), row?.meeting_start_at);
  check('meeting_end_at is stored',             row?.meeting_end_at   === end.toISOString(),   row?.meeting_end_at);
  check('start round-trips as a Date',          new Date(row.meeting_start_at).getTime() === start.getTime());
  check('end round-trips as a Date',            new Date(row.meeting_end_at).getTime()   === end.getTime());
}

// ── saveBooking() still works (regression) ────────────────────────────────────
console.log('\nsaveBooking() regression');
{
  saveBooking(matchId, { calendarEventId: 'AAMkXYZ', teamsLink: 'https://teams.microsoft.com/fake' });
  const row = getMatch(matchId);
  check('calendar_event_id saved',   row?.calendar_event_id === 'AAMkXYZ', row?.calendar_event_id);
  check('teams_link saved',          row?.teams_link?.startsWith('https://'), row?.teams_link);
  check('booked_at set',             !!row?.booked_at);
  check('meeting times preserved',   !!row?.meeting_start_at && !!row?.meeting_end_at);
}

// ── feedback column accepts valid values ──────────────────────────────────────
console.log('\nfeedback column values');
{
  for (const val of ['good', 'meh', 'snoozed', null]) {
    db.prepare(`UPDATE matches SET feedback = ? WHERE id = ?`).run(val, matchId);
    const row = db.prepare(`SELECT feedback FROM matches WHERE id = ?`).get(matchId);
    check(`feedback accepts '${val}'`, row?.feedback === val, row?.feedback);
  }
}

// ── Results ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(42)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(42));

try { fs.unlinkSync(dbPath); } catch (_) {}
if (failed > 0) process.exit(1);
