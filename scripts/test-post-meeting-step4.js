'use strict';

// Phase 11 Step 4 — Feedback button handler tests
//
// Tests:
//   • saveFeedback()              — writes correct value to DB
//   • buildGoodConfirmation()     — correct block content
//   • buildMehConfirmation()      — correct block content
//   • buildSnoozeConfirmation()   — correct block content, mentions resume command
//   • handleMeetingGood (mock)    — acks, saves feedback, updates message
//   • handleMeetingMeh  (mock)    — acks, saves feedback, updates message
//   • handleMeetingSnooze (mock)  — acks, pauses user, saves feedback, updates message
//
// Run: npm run test:post4

process.env.ADMIN_USER_IDS = 'UADMIN0';
process.env.DATABASE_PATH  = './data/test-post4.db';

const fs = require('node:fs');
fs.mkdirSync('./data', { recursive: true });
const dbPath = process.env.DATABASE_PATH;
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const { initDb }    = require('../src/db/init');
const { getDb }     = require('../src/db/connection');
const { saveFeedback, getMatch } = require('../src/lib/rounds');
const {
  handleMeetingGood,
  handleMeetingMeh,
  handleMeetingSnooze,
  buildGoodConfirmation,
  buildMehConfirmation,
  buildSnoozeConfirmation,
} = require('../src/commands/actions/meetingFeedback');

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

console.log('\n=== Phase 11 — Step 4: Feedback Button Handler Tests ===\n');

initDb();
const db = getDb();

// Seed: round + match + two users
db.prepare(`INSERT INTO rounds (status, started_at, completed_at, created_by) VALUES ('completed', datetime('now'), datetime('now'), 'test')`).run();
const roundId = db.prepare(`SELECT last_insert_rowid() AS id`).get().id;

db.prepare(`INSERT INTO matches (round_id, slack_dm_channel_id) VALUES (?, 'C_TEST')`).run(roundId);
const matchId = db.prepare(`SELECT last_insert_rowid() AS id`).get().id;

db.prepare(`INSERT INTO users (slack_user_id, display_name, is_active, is_paused) VALUES ('U_CLICKER', 'Alice', 1, 0)`).run();
db.prepare(`INSERT INTO users (slack_user_id, display_name, is_active, is_paused) VALUES ('U_OTHER', 'Bob', 1, 0)`).run();

// ── saveFeedback ──────────────────────────────────────────────────────────────
console.log('saveFeedback()');
{
  saveFeedback(matchId, 'good');
  let row = db.prepare(`SELECT feedback FROM matches WHERE id = ?`).get(matchId);
  check("stores 'good'",    row?.feedback === 'good',    row?.feedback);

  saveFeedback(matchId, 'meh');
  row = db.prepare(`SELECT feedback FROM matches WHERE id = ?`).get(matchId);
  check("stores 'meh'",     row?.feedback === 'meh',     row?.feedback);

  saveFeedback(matchId, 'snoozed');
  row = db.prepare(`SELECT feedback FROM matches WHERE id = ?`).get(matchId);
  check("stores 'snoozed'", row?.feedback === 'snoozed', row?.feedback);

  // Reset for handler tests
  saveFeedback(matchId, null);
}

// ── Message builders ──────────────────────────────────────────────────────────
console.log('\nMessage builders');
{
  const good = buildGoodConfirmation();
  check('good: returns array',          Array.isArray(good));
  check('good: single section block',   good[0]?.type === 'section');
  check('good: mentions "Glad"',        good[0]?.text?.text?.includes('Glad'), good[0]?.text?.text);
  check('good: has coffee emoji',       good[0]?.text?.text?.includes('☕'));

  const meh = buildMehConfirmation();
  check('meh: returns array',           Array.isArray(meh));
  check('meh: single section block',    meh[0]?.type === 'section');
  check('meh: mentions feedback',       meh[0]?.text?.text?.includes('feedback'), meh[0]?.text?.text);

  const snooze = buildSnoozeConfirmation();
  check('snooze: returns array',        Array.isArray(snooze));
  check('snooze: single section block', snooze[0]?.type === 'section');
  check('snooze: mentions snooze',      snooze[0]?.text?.text?.includes('snoozed'), snooze[0]?.text?.text);
  check('snooze: mentions /watercooler resume', snooze[0]?.text?.text?.includes('/watercooler resume'), snooze[0]?.text?.text);
}

// ── Mock Slack client ─────────────────────────────────────────────────────────
// Captures acks and chat.update calls so we can verify handler behaviour
// without a live Slack connection.

function makeMocks(matchIdStr, clickerUserId = 'U_CLICKER') {
  let ackCalled = false;
  let updatePayload = null;

  const ack    = async () => { ackCalled = true; };
  const client = {
    chat: {
      update: async (payload) => { updatePayload = payload; },
    },
  };
  const action = { value: matchIdStr };
  const body   = {
    channel: { id: 'C_TEST' },
    message: { ts: '1234567890.123456' },
    user:    { id: clickerUserId },
  };

  return { ack, client, action, body, get ackCalled() { return ackCalled; }, get updatePayload() { return updatePayload; } };
}

// ── Handler tests (sequential async) ─────────────────────────────────────────
(async () => {

  // ── handleMeetingGood ──────────────────────────────────────────────────────
  console.log('\nhandleMeetingGood()');
  {
    const m = makeMocks(String(matchId));
    await handleMeetingGood({ action: m.action, ack: m.ack, body: m.body, client: m.client });

    check('acks the action',                m.ackCalled);
    const row = db.prepare(`SELECT feedback FROM matches WHERE id = ?`).get(matchId);
    check("stores 'good' feedback",         row?.feedback === 'good', row?.feedback);
    check('calls chat.update',              !!m.updatePayload);
    check('update targets correct channel', m.updatePayload?.channel === 'C_TEST');
    check('update targets correct ts',      m.updatePayload?.ts === '1234567890.123456');
    check('update text mentions good',      m.updatePayload?.text?.includes('good') || m.updatePayload?.text?.includes('👍'), m.updatePayload?.text);

    saveFeedback(matchId, null); // reset
  }

  // ── handleMeetingMeh ───────────────────────────────────────────────────────
  console.log('\nhandleMeetingMeh()');
  {
    const m = makeMocks(String(matchId));
    await handleMeetingMeh({ action: m.action, ack: m.ack, body: m.body, client: m.client });

    check('acks the action',                m.ackCalled);
    const row = db.prepare(`SELECT feedback FROM matches WHERE id = ?`).get(matchId);
    check("stores 'meh' feedback",          row?.feedback === 'meh', row?.feedback);
    check('calls chat.update',              !!m.updatePayload);

    saveFeedback(matchId, null); // reset
  }

  // ── handleMeetingSnooze ────────────────────────────────────────────────────
  console.log('\nhandleMeetingSnooze()');
  {
    const m = makeMocks(String(matchId), 'U_CLICKER');
    await handleMeetingSnooze({ action: m.action, ack: m.ack, body: m.body, client: m.client });

    check('acks the action',                m.ackCalled);
    const row = db.prepare(`SELECT feedback FROM matches WHERE id = ?`).get(matchId);
    check("stores 'snoozed' feedback",      row?.feedback === 'snoozed', row?.feedback);
    const clicker = db.prepare(`SELECT is_paused FROM users WHERE slack_user_id = 'U_CLICKER'`).get();
    check('pauses the clicker',             clicker?.is_paused === 1, clicker?.is_paused);
    const other = db.prepare(`SELECT is_paused FROM users WHERE slack_user_id = 'U_OTHER'`).get();
    check('does NOT pause other user',      other?.is_paused === 0, other?.is_paused);
    check('calls chat.update',              !!m.updatePayload);
    check('update mentions snoozed',        m.updatePayload?.text?.toLowerCase().includes('snooze') || m.updatePayload?.text?.includes('🤗'), m.updatePayload?.text);
  }

  // ── invalid matchId guard ──────────────────────────────────────────────────
  console.log('\nInvalid matchId guard');
  {
    const m = makeMocks('not-a-number');
    await handleMeetingGood({ action: m.action, ack: m.ack, body: m.body, client: m.client });
    check('acks even with bad value',       m.ackCalled);
    check('does not call chat.update',      !m.updatePayload);
  }

  // ── Results ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));

  try { fs.unlinkSync(dbPath); } catch (_) {}
  if (failed > 0) process.exit(1);

})();
