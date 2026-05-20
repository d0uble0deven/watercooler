'use strict';

// Local test script for Phase 5 — Admin Dry Run.
// Calls handlers directly — no Slack credentials needed.
// Usage: npm run test:dry-run
//
// What this covers:
//   1. Empty state (no users)
//   2. Single user (can't match)
//   3. 4 eligible users + 1 paused + 1 excluded (only 4 should appear)
//   4. Non-admin rejection
//   5. Admin with pair history (repeat pairs flagged)
//   6. Odd eligible count → trio shown in preview

// ── Set env vars BEFORE any requires so config.js picks them up ────────────────
process.env.ADMIN_USER_IDS = 'U_DRY_ADMIN';

const { initDb }    = require('../src/db/init');
const { getDb }     = require('../src/db/connection');
const { isAdmin }   = require('../src/lib/adminGuard');
const dryRun        = require('../src/commands/admin/dry-run');
const { handleAdmin } = require('../src/commands/admin/index');

initDb();
const db = getDb();

// ── Helpers ────────────────────────────────────────────────────────────────────

function mockAdmin(text = 'dry-run') {
  return { user_id: 'U_DRY_ADMIN', user_name: 'test.admin', text: `admin ${text}` };
}

function mockNonAdmin() {
  return { user_id: 'U_DRY_USER', user_name: 'regular.user', text: 'admin dry-run' };
}

const responses = [];
async function respond(msg) {
  const text = typeof msg === 'string' ? msg : (msg.text || JSON.stringify(msg));
  responses.push(text);
  // Indent each line for readability
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

function cleanupTestData() {
  db.prepare("DELETE FROM pair_history WHERE round_id IN (SELECT id FROM rounds WHERE created_by LIKE 'test%')").run();
  db.prepare("DELETE FROM rounds WHERE created_by LIKE 'test%'").run();
  db.prepare("DELETE FROM exclusions WHERE slack_user_id LIKE 'U_DRY%'").run();
  db.prepare("DELETE FROM users WHERE slack_user_id LIKE 'U_DRY%'").run();
}

function insertUser(slackId, name, isActive = 1, isPaused = 0) {
  db.prepare(`
    INSERT OR REPLACE INTO users (slack_user_id, display_name, is_active, is_paused)
    VALUES (?, ?, ?, ?)
  `).run(slackId, name, isActive, isPaused);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

async function run() {
  cleanupTestData(); // clean up any leftovers from a previous run

  console.log('\n══════════════════════════════════════════');
  console.log('  Watercooler — Phase 5 dry-run tests');
  console.log('══════════════════════════════════════════');

  // ── 1. Admin guard ──────────────────────────────────────────────────────────
  await test('isAdmin() — configured admin user', async () => {
    console.log(`   → isAdmin('U_DRY_ADMIN') = ${isAdmin('U_DRY_ADMIN')}`);
    console.log(`   → isAdmin('U_DRY_USER')  = ${isAdmin('U_DRY_USER')}`);
  });

  await test('handleAdmin — non-admin rejected', async () => {
    await handleAdmin(mockNonAdmin(), '', respond);
    // expect: "⛔ admins only"
  });

  // ── 2. Empty state ──────────────────────────────────────────────────────────
  await test('dry-run — no eligible participants (empty DB)', async () => {
    await dryRun(mockAdmin(), respond);
    // expect: "no eligible participants"
  });

  // ── 3. Single user ──────────────────────────────────────────────────────────
  await test('dry-run — only 1 eligible user', async () => {
    insertUser('U_DRY_1', 'Alice');
    await dryRun(mockAdmin(), respond);
    // expect: "Only 1 eligible participant"
  });

  // ── 4. Mixed user states ────────────────────────────────────────────────────
  await test('dry-run — 4 eligible, 1 paused, 1 excluded', async () => {
    // Already have U_DRY_1 (Alice) active from previous test
    insertUser('U_DRY_2', 'Bob');
    insertUser('U_DRY_3', 'Carol');
    insertUser('U_DRY_4', 'Dave');
    insertUser('U_DRY_5', 'Eve',   1, 1); // paused — should NOT appear
    insertUser('U_DRY_6', 'Frank', 0, 0); // left  — should NOT appear
    db.prepare(`
      INSERT OR REPLACE INTO exclusions (slack_user_id, reason, created_by)
      VALUES ('U_DRY_7', 'test exclusion', 'U_DRY_ADMIN')
    `).run();
    insertUser('U_DRY_7', 'Grace');        // excluded — should NOT appear

    await dryRun(mockAdmin(), respond);
    // expect: 4 eligible participants, 2 pairs (Alice/Bob/Carol/Dave)
  });

  // ── 5. Odd eligible count ───────────────────────────────────────────────────
  await test('dry-run — 3 eligible users → 1 trio', async () => {
    // Remove Dave temporarily by pausing him
    db.prepare("UPDATE users SET is_paused = 1 WHERE slack_user_id = 'U_DRY_4'").run();
    await dryRun(mockAdmin(), respond);
    // expect: 3 participants, 1 group (trio)
    db.prepare("UPDATE users SET is_paused = 0 WHERE slack_user_id = 'U_DRY_4'").run(); // restore
  });

  // ── 6. With pair history (repeat flagging) ──────────────────────────────────
  await test('dry-run — repeat pairs flagged when all combos exhausted', async () => {
    // Get Alice and Bob's internal IDs
    const alice = db.prepare("SELECT id FROM users WHERE slack_user_id = 'U_DRY_1'").get();
    const bob   = db.prepare("SELECT id FROM users WHERE slack_user_id = 'U_DRY_2'").get();
    const carol = db.prepare("SELECT id FROM users WHERE slack_user_id = 'U_DRY_3'").get();
    const dave  = db.prepare("SELECT id FROM users WHERE slack_user_id = 'U_DRY_4'").get();

    // Seed a completed round with all possible pair combos so every pairing is a repeat
    const roundResult = db.prepare(`
      INSERT INTO rounds (status, started_at, completed_at, created_by)
      VALUES ('completed', datetime('now'), datetime('now'), 'test-seeder')
    `).run();
    const roundId = roundResult.lastInsertRowid;

    // Record all 6 possible pairs among 4 users
    const stmt = db.prepare(`INSERT INTO pair_history (user_a_id, user_b_id, round_id) VALUES (?, ?, ?)`);
    const pairs = [
      [alice.id, bob.id],
      [alice.id, carol.id],
      [alice.id, dave.id],
      [bob.id,   carol.id],
      [bob.id,   dave.id],
      [carol.id, dave.id],
    ].map(([a, b]) => [Math.min(a,b), Math.max(a,b)]);

    for (const [a, b] of pairs) stmt.run(a, b, roundId);

    await dryRun(mockAdmin(), respond);
    // expect: 4 participants, 2 groups, both flagged as ⚠️ repeat
  });

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  cleanupTestData();

  console.log('\n══════════════════════════════════════════');
  console.log('  All scenarios complete — test data cleaned up');
  console.log('══════════════════════════════════════════\n');
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
