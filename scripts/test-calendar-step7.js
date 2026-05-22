'use strict';

// Phase 10 Step 7 — Auto-booking unit tests
//
// Tests bookingDeadlineHours(), buildAutoBookedMessage(), buildNoSlotsMessage(),
// and the DB query getUnbookedMatchesPastDeadline() using a real test database.
//
// No Azure credentials or Slack tokens required.
//
// Run: npm run test:step7

process.env.ADMIN_USER_IDS = 'UADMIN0';
process.env.DATABASE_PATH  = './data/test-step7.db';

const fs = require('node:fs');
fs.mkdirSync('./data', { recursive: true });
const dbPath = process.env.DATABASE_PATH;
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const { initDb }          = require('../src/db/init');
const { getDb }           = require('../src/db/connection');
const {
  bookingDeadlineHours,
  buildAutoBookedMessage,
  buildNoSlotsMessage,
} = require('../src/integrations/calendarAutoBooker');
const { getUnbookedMatchesPastDeadline } = require('../src/lib/rounds');

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

const TEAMS_LINK = 'https://teams.microsoft.com/l/meetup-join/fake';
const ALICE = { display_name: 'Alice', slack_email: 'alice@docme360.com' };
const BOB   = { display_name: 'Bob',   slack_email: 'bob@docme360.com'   };
const START = new Date('2025-06-09T09:00:00Z');
const END   = new Date('2025-06-09T09:30:00Z');

console.log('\n=== Phase 10 — Step 7: Auto-Booking Tests ===\n');

// ── bookingDeadlineHours ──────────────────────────────────────────────────────
console.log('bookingDeadlineHours()');
{
  check('2.5 days → 52 hours',    bookingDeadlineHours(2.5)  === 52,   bookingDeadlineHours(2.5));
  check('2.0 days → 48 hours',    bookingDeadlineHours(2.0)  === 48,   bookingDeadlineHours(2.0));
  check('1.0 day  → 24 hours',    bookingDeadlineHours(1.0)  === 24,   bookingDeadlineHours(1.0));
  check('0.5 days →  4 hours',    bookingDeadlineHours(0.5)  === 4,    bookingDeadlineHours(0.5));
  check('3.0 days → 72 hours',    bookingDeadlineHours(3.0)  === 72,   bookingDeadlineHours(3.0));
  check('1.5 days → 28 hours',    bookingDeadlineHours(1.5)  === 28,   bookingDeadlineHours(1.5));
}

// ── buildAutoBookedMessage ────────────────────────────────────────────────────
console.log('\nbuildAutoBookedMessage()');
{
  const booking = { start: START, end: END, teamsLink: TEAMS_LINK };
  const blocks  = buildAutoBookedMessage(booking, [ALICE, BOB], 'UTC');

  check('returns an array',                Array.isArray(blocks));

  const section = blocks.find((b) => b.type === 'section');
  check('has section block',               !!section);
  check('section shows ⏰ auto-booked',    section?.text?.text?.includes('⏰'), section?.text?.text);
  check('section shows participant names', section?.text?.text?.includes('Alice'), section?.text?.text);
  check('section shows meeting time',      section?.text?.text?.includes('Jun'), section?.text?.text);

  const actions = blocks.find((b) => b.type === 'actions');
  check('has Teams button',                !!actions);
  check('Teams button URL is set',         actions?.elements?.[0]?.url === TEAMS_LINK);

  const context = blocks.find((b) => b.type === 'context');
  check('has context block',               !!context);
  check('context mentions deadline',       context?.elements?.[0]?.text?.includes('deadline'), context?.elements?.[0]?.text);

  // Without Teams link
  const noTeams = buildAutoBookedMessage({ start: START, end: END, teamsLink: null }, [ALICE], 'UTC');
  check('no actions block without Teams link', !noTeams.some((b) => b.type === 'actions'));
}

// ── buildNoSlotsMessage ───────────────────────────────────────────────────────
console.log('\nbuildNoSlotsMessage()');
{
  const blocks = buildNoSlotsMessage();
  check('returns an array',                 Array.isArray(blocks));
  check('has section block',                blocks[0]?.type === 'section');
  check('mentions deadline',                blocks[0]?.text?.text?.includes('deadline'), blocks[0]?.text?.text);
  check('asks to coordinate in chat',       blocks[0]?.text?.text?.includes('chat'), blocks[0]?.text?.text);
}

// ── getUnbookedMatchesPastDeadline ────────────────────────────────────────────
console.log('\ngetUnbookedMatchesPastDeadline() — DB query');

initDb();

{
  const db = getDb();

  // Seed: one user
  db.prepare(`INSERT INTO users (slack_user_id, display_name) VALUES ('U1', 'Alice')`).run();

  // Round completed 100 hours ago (well past any reasonable deadline)
  const longAgo = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO rounds (status, started_at, completed_at, created_by) VALUES ('completed', ?, ?, 'scheduler')`)
    .run(longAgo, longAgo);
  const oldRoundId = db.prepare(`SELECT last_insert_rowid() AS id`).get().id;

  // Round completed 1 hour ago (within deadline)
  const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO rounds (status, started_at, completed_at, created_by) VALUES ('completed', ?, ?, 'scheduler')`)
    .run(recentTime, recentTime);
  const recentRoundId = db.prepare(`SELECT last_insert_rowid() AS id`).get().id;

  // Match A: old round, no booking, has DM channel → SHOULD be returned
  db.prepare(`INSERT INTO matches (round_id, slack_dm_channel_id) VALUES (?, 'C_OLD')`).run(oldRoundId);
  const matchAId = db.prepare(`SELECT last_insert_rowid() AS id`).get().id;

  // Match B: old round, already booked → should NOT be returned
  db.prepare(`INSERT INTO matches (round_id, slack_dm_channel_id, calendar_event_id) VALUES (?, 'C_BOOKED', 'AAMkXYZ')`).run(oldRoundId);

  // Match C: old round, no DM channel → should NOT be returned
  db.prepare(`INSERT INTO matches (round_id) VALUES (?)`).run(oldRoundId);

  // Match D: recent round, no booking → should NOT be returned (within deadline)
  db.prepare(`INSERT INTO matches (round_id, slack_dm_channel_id) VALUES (?, 'C_RECENT')`).run(recentRoundId);

  // Query with 52h deadline — only Match A should qualify
  const results = getUnbookedMatchesPastDeadline(52);
  check('returns exactly 1 match',             results.length === 1, results.length);
  check('returned match is Match A',           results[0]?.id === matchAId, results[0]?.id);
  check('returned match has DM channel',       results[0]?.slack_dm_channel_id === 'C_OLD', results[0]?.slack_dm_channel_id);
  check('returned match has no booking',       results[0]?.calendar_event_id === null, results[0]?.calendar_event_id);

  // Query with 0h deadline — all unbooked matches with DM channels qualify
  const allResults = getUnbookedMatchesPastDeadline(0);
  check('0h deadline returns old + recent unbooked', allResults.length === 2, allResults.length);
}

// ── calendar_suggestion_ts column exists ──────────────────────────────────────
console.log('\ncalendar_suggestion_ts column exists on matches');
{
  const db = getDb();
  let threw = false;
  try {
    db.prepare(`UPDATE matches SET calendar_suggestion_ts = ? WHERE id = 1`).run('1234567890.123456');
  } catch (_) { threw = true; }
  check('can write calendar_suggestion_ts without error', !threw);

  const row = db.prepare(`SELECT calendar_suggestion_ts FROM matches WHERE id = 1`).get();
  check('stored ts can be read back', row?.calendar_suggestion_ts === '1234567890.123456', row?.calendar_suggestion_ts);
}

// ── Results ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(42)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(42));

try { fs.unlinkSync(dbPath); } catch (_) {}
if (failed > 0) process.exit(1);
