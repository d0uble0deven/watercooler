'use strict';

// Local test script for Phase 6 — Admin Real Run.
// Uses a mock Slack client so no real credentials are needed.
// Usage: npm run test:run
//
// What this covers:
//   1. Intro message formatting (pure function — no Slack needed)
//   2. Empty/single user guard
//   3. Successful run: round created, matches saved, pair history recorded
//   4. Eligibility filtering (paused/excluded users not in matches)
//   5. Duplicate round prevention
//   6. Partial failure (one group's DM fails — rest should still complete)
//   7. Second run avoids first-run pairs (pair history respected)

// Set env vars BEFORE any module loads
process.env.ADMIN_USER_IDS = 'U_RUN_ADMIN';

const { initDb }  = require('../src/db/init');
const { getDb }   = require('../src/db/connection');
const run         = require('../src/commands/admin/run');
const { buildIntroMessage, formatNameList } = require('../src/slack/messaging');

initDb();
const db = getDb();

// ── Mock Slack client ─────────────────────────────────────────────────────────
// Simulates Slack API calls so we can test all DB logic without real credentials.

let dmOpenCount = 0;
let messagePostCount = 0;
let forceDmFailure = false; // set true to simulate a Slack error for one group

const mockClient = {
  conversations: {
    open: async ({ users }) => {
      if (forceDmFailure) {
        forceDmFailure = false; // fail once, then recover
        throw new Error('Slack API error: channel_not_found (simulated)');
      }
      dmOpenCount++;
      const channelId = `MOCK_C_${dmOpenCount}`;
      console.log(`   [Slack] conversations.open(${users}) → ${channelId}`);
      return { ok: true, channel: { id: channelId } };
    },
  },
  chat: {
    postMessage: async ({ channel, text }) => {
      messagePostCount++;
      console.log(`   [Slack] chat.postMessage → ${channel}`);
      console.log(`           "${text.slice(0, 90)}${text.length > 90 ? '...' : ''}"`);
      return { ok: true, ts: `${Date.now()}` };
    },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockCmd() {
  return { user_id: 'U_RUN_ADMIN', user_name: 'admin', text: 'admin run' };
}

async function respond(msg) {
  const text = typeof msg === 'string' ? msg : (msg.text || JSON.stringify(msg));
  text.split('\n').forEach((line) => console.log(`   ${line}`));
}

async function test(label, fn) {
  console.log(`\n[ ${label} ]`);
  try {
    await fn();
  } catch (err) {
    console.error(`   ✗ THREW: ${err.message}`);
  }
}

function insertUser(slackId, name, isActive = 1, isPaused = 0) {
  db.prepare(`
    INSERT OR REPLACE INTO users (slack_user_id, display_name, is_active, is_paused)
    VALUES (?, ?, ?, ?)
  `).run(slackId, name, isActive, isPaused);
}

function cleanupTestData() {
  db.prepare("DELETE FROM pair_history WHERE round_id IN (SELECT id FROM rounds WHERE created_by = 'U_RUN_ADMIN')").run();
  db.prepare("DELETE FROM match_members WHERE match_id IN (SELECT id FROM matches WHERE round_id IN (SELECT id FROM rounds WHERE created_by = 'U_RUN_ADMIN'))").run();
  db.prepare("DELETE FROM matches WHERE round_id IN (SELECT id FROM rounds WHERE created_by = 'U_RUN_ADMIN')").run();
  db.prepare("DELETE FROM rounds WHERE created_by = 'U_RUN_ADMIN'").run();
  db.prepare("DELETE FROM exclusions WHERE slack_user_id LIKE 'U_RUN%'").run();
  db.prepare("DELETE FROM users WHERE slack_user_id LIKE 'U_RUN%'").run();
}

// ── Tests ──────────────────────────────────────────────────────────────────────

async function runAll() {
  cleanupTestData();
  dmOpenCount = 0;
  messagePostCount = 0;

  console.log('\n══════════════════════════════════════════');
  console.log('  Watercooler — Phase 6 run tests');
  console.log('══════════════════════════════════════════');

  // ── 1. Message formatting (pure, no Slack) ──────────────────────────────────
  await test('formatNameList — 1, 2, 3 names', async () => {
    console.log(`   → "${formatNameList(['Alice'])}"`);
    console.log(`   → "${formatNameList(['Alice', 'Bob'])}"`);
    console.log(`   → "${formatNameList(['Alice', 'Bob', 'Carol'])}"`);
    console.log(`   → "${formatNameList(['Alice', 'Bob', 'Carol', 'Dave'])}"`);
  });

  await test('buildIntroMessage — pair', async () => {
    const users = [{ display_name: 'Alice' }, { display_name: 'Bob' }];
    console.log(`   → "${buildIntroMessage(users)}"`);
  });

  await test('buildIntroMessage — trio', async () => {
    const users = [{ display_name: 'Alice' }, { display_name: 'Bob' }, { display_name: 'Carol' }];
    console.log(`   → "${buildIntroMessage(users)}"`);
  });

  // ── 2. Edge cases: too few users ────────────────────────────────────────────
  await test('run — no eligible participants', async () => {
    await run(mockCmd(), respond, mockClient);
    // expect: "No eligible participants"
  });

  await test('run — only 1 eligible user', async () => {
    insertUser('U_RUN_1', 'Alice');
    await run(mockCmd(), respond, mockClient);
    // expect: "Only 1 eligible participant"
  });

  // ── 3. Successful run ───────────────────────────────────────────────────────
  await test('run — 4 eligible users (+ 1 paused, 1 excluded)', async () => {
    // Alice already inserted above
    insertUser('U_RUN_2', 'Bob');
    insertUser('U_RUN_3', 'Carol');
    insertUser('U_RUN_4', 'Dave');
    insertUser('U_RUN_5', 'Eve',   1, 1); // paused — should be excluded
    insertUser('U_RUN_6', 'Frank', 0, 0); // left — should be excluded
    db.prepare(`INSERT OR REPLACE INTO exclusions (slack_user_id, reason, created_by) VALUES ('U_RUN_7', 'test', 'U_RUN_ADMIN')`).run();
    insertUser('U_RUN_7', 'Grace');        // admin-excluded — should be excluded

    const beforeRounds = db.prepare('SELECT COUNT(*) AS n FROM rounds').get().n;

    await run(mockCmd(), respond, mockClient);

    const round = db.prepare("SELECT * FROM rounds WHERE created_by = 'U_RUN_ADMIN' ORDER BY id DESC LIMIT 1").get();
    const matches = db.prepare('SELECT * FROM matches WHERE round_id = ?').all(round.id);
    const members = db.prepare(`
      SELECT u.display_name FROM match_members mm
      JOIN users u ON u.id = mm.user_id
      WHERE mm.match_id IN (SELECT id FROM matches WHERE round_id = ?)
    `).all(round.id);
    const pairHist = db.prepare('SELECT * FROM pair_history WHERE round_id = ?').all(round.id);

    console.log(`\n   ── DB state after run ──`);
    console.log(`   Round #${round.id} status: ${round.status}`);
    console.log(`   Matches created: ${matches.length}`);
    console.log(`   Members matched: ${members.map(m => m.display_name).join(', ')}`);
    console.log(`   Pair history entries: ${pairHist.length}`);
    console.log(`   DM channels: ${matches.map(m => m.slack_dm_channel_id).join(', ')}`);

    // Verify Eve, Frank, Grace are NOT in match members
    const matchedNames = members.map(m => m.display_name);
    const shouldBeAbsent = ['Eve', 'Frank', 'Grace'];
    for (const name of shouldBeAbsent) {
      const found = matchedNames.includes(name);
      console.log(`   ${found ? '✗ UNEXPECTED' : '✓ Correctly excluded'}: ${name}`);
    }
  });

  // ── 4. Duplicate round prevention ──────────────────────────────────────────
  await test('run — duplicate prevention (pending round exists)', async () => {
    // Manually insert a pending round
    db.prepare(`INSERT INTO rounds (status, started_at, created_by) VALUES ('pending', datetime('now'), 'U_RUN_ADMIN')`).run();
    await run(mockCmd(), respond, mockClient);
    // expect: "⚠️ A round is already in progress"
    // Clean up the fake pending round
    db.prepare("DELETE FROM rounds WHERE status = 'pending' AND created_by = 'U_RUN_ADMIN'").run();
  });

  // ── 5. Partial failure (one DM fails) ──────────────────────────────────────
  await test('run — partial failure: one group DM fails', async () => {
    forceDmFailure = true; // first DM call will throw

    const beforePairHistory = db.prepare('SELECT COUNT(*) AS n FROM pair_history').get().n;

    await run(mockCmd(), respond, mockClient);

    const round = db.prepare("SELECT * FROM rounds WHERE created_by = 'U_RUN_ADMIN' ORDER BY id DESC LIMIT 1").get();
    const matches = db.prepare('SELECT * FROM matches WHERE round_id = ?').all(round.id);
    const afterPairHistory = db.prepare('SELECT COUNT(*) AS n FROM pair_history').get().n;

    console.log(`\n   ── Partial failure state ──`);
    console.log(`   Round status: ${round.status} (should be 'completed' even on partial failure)`);
    console.log(`   Matches saved: ${matches.length} (1 failed, rest succeeded)`);
    console.log(`   Pair history entries added: ${afterPairHistory - beforePairHistory}`);
  });

  // ── 6. Second run respects pair history ────────────────────────────────────
  await test('run — second run uses pair history from first run', async () => {
    const pairHistoryBefore = db.prepare('SELECT COUNT(*) AS n FROM pair_history').get().n;

    await run(mockCmd(), respond, mockClient);

    const pairHistoryAfter = db.prepare('SELECT COUNT(*) AS n FROM pair_history').get().n;
    console.log(`   Pair history grew from ${pairHistoryBefore} → ${pairHistoryAfter} entries`);

    // Show all rounds
    const allRounds = db.prepare("SELECT id, status, created_by FROM rounds WHERE created_by = 'U_RUN_ADMIN' ORDER BY id").all();
    console.log(`   Total rounds run: ${allRounds.length}`);
  });

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  cleanupTestData();

  console.log('\n══════════════════════════════════════════');
  console.log(`  All scenarios complete — test data cleaned up`);
  console.log(`  Slack mock calls — DMs opened: ${dmOpenCount}, messages posted: ${messagePostCount}`);
  console.log('══════════════════════════════════════════\n');
}

runAll().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
