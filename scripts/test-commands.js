'use strict';

// Local test script for Phase 3 user commands.
// Calls handlers directly — no Slack credentials needed.
// Usage: npm run test:commands
//
// Uses a test user ID (U_WTEST_1) that gets cleaned up at the end.

const { initDb } = require('../src/db/init');
const { getDb }  = require('../src/db/connection');

const join   = require('../src/commands/user/join');
const pause  = require('../src/commands/user/pause');
const resume = require('../src/commands/user/resume');
const leave  = require('../src/commands/user/leave');
const status = require('../src/commands/user/status');

// Make sure tables exist before running tests
initDb();

const db = getDb();

// ── Helpers ───────────────────────────────────────────────────────────────────

// Simulate a Slack command payload
function mockCmd(userId = 'U_WTEST_1', userName = 'test.user') {
  return { user_id: userId, user_name: userName, text: '' };
}

// Capture the response text and print it
async function respond(msg) {
  const text = typeof msg === 'string' ? msg : (msg.text || JSON.stringify(msg));
  console.log(`   → ${text}`);
}

let passed = 0;
let failed = 0;

async function test(label, fn) {
  process.stdout.write(`[ ${label} ]\n`);
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`   ✗ THREW: ${err.message}`);
    failed++;
  }
  console.log('');
}

// ── Test runner ───────────────────────────────────────────────────────────────

async function run() {
  // Clean up any leftover test data from a previous run
  db.prepare("DELETE FROM exclusions WHERE slack_user_id LIKE 'U_WTEST_%'").run();
  db.prepare("DELETE FROM users WHERE slack_user_id LIKE 'U_WTEST_%'").run();

  console.log('\n══════════════════════════════════════════');
  console.log('  Watercooler — Phase 3 command tests');
  console.log('══════════════════════════════════════════\n');

  // ── Status before joining ─────────────────────────────────────────────────
  await test('status — not joined yet', async () => {
    await status(mockCmd(), respond);
    // expect: "You're not participating..."
  });

  // ── Join ──────────────────────────────────────────────────────────────────
  await test('join — first time', async () => {
    await join(mockCmd(), respond);
    // expect: "You've joined Watercooler!"
  });

  await test('join — already active (should reject)', async () => {
    await join(mockCmd(), respond);
    // expect: "You're already participating..."
  });

  // ── Status after joining ──────────────────────────────────────────────────
  await test('status — active', async () => {
    await status(mockCmd(), respond);
    // expect: "✅ Active"
  });

  // ── Pause ─────────────────────────────────────────────────────────────────
  await test('pause', async () => {
    await pause(mockCmd(), respond);
    // expect: "⏸ You're now paused..."
  });

  await test('pause — already paused (should reject)', async () => {
    await pause(mockCmd(), respond);
    // expect: "You're already paused..."
  });

  await test('status — paused', async () => {
    await status(mockCmd(), respond);
    // expect: "⏸ Paused"
  });

  await test('join — while paused (should redirect to resume)', async () => {
    await join(mockCmd(), respond);
    // expect: "Use /watercooler resume..."
  });

  // ── Resume ────────────────────────────────────────────────────────────────
  await test('resume', async () => {
    await resume(mockCmd(), respond);
    // expect: "▶️ You're back!"
  });

  await test('resume — not paused (should reject)', async () => {
    await resume(mockCmd(), respond);
    // expect: "You're not paused..."
  });

  // ── Leave ─────────────────────────────────────────────────────────────────
  await test('leave', async () => {
    await leave(mockCmd(), respond);
    // expect: "You've left Watercooler..."
  });

  await test('leave — already left (should reject)', async () => {
    await leave(mockCmd(), respond);
    // expect: "You're not a participant..."
  });

  await test('status — after leaving', async () => {
    await status(mockCmd(), respond);
    // expect: "You're not participating..."
  });

  // ── Rejoin ────────────────────────────────────────────────────────────────
  await test('join — rejoin after leaving', async () => {
    await join(mockCmd(), respond);
    // expect: "Welcome back!"
  });

  await test('status — active again', async () => {
    await status(mockCmd(), respond);
    // expect: "✅ Active"
  });

  // ── Exclusions ────────────────────────────────────────────────────────────
  await test('setup — insert admin exclusion for U_WTEST_2', async () => {
    db.prepare(`
      INSERT OR REPLACE INTO exclusions (slack_user_id, reason, created_by)
      VALUES ('U_WTEST_2', 'test exclusion', 'admin')
    `).run();
    console.log('   → Exclusion row inserted');
  });

  await test('join — excluded user (should be blocked)', async () => {
    await join(mockCmd('U_WTEST_2', 'excluded.user'), respond);
    // expect: "⛔ excluded..."
  });

  await test('status — excluded user', async () => {
    await status(mockCmd('U_WTEST_2', 'excluded.user'), respond);
    // expect: "⛔ Excluded"
  });

  await test('resume — user who never joined', async () => {
    await resume(mockCmd('U_WTEST_3', 'never.joined'), respond);
    // expect: "You're not a participant..."
  });

  await test('pause — user who never joined', async () => {
    await pause(mockCmd('U_WTEST_3', 'never.joined'), respond);
    // expect: "You're not a participant..."
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────
  db.prepare("DELETE FROM exclusions WHERE slack_user_id LIKE 'U_WTEST_%'").run();
  db.prepare("DELETE FROM users WHERE slack_user_id LIKE 'U_WTEST_%'").run();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════');
  console.log(`  ${passed} scenarios run | test data cleaned up`);
  console.log('══════════════════════════════════════════\n');
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
