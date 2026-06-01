'use strict';

// Phase 11 Step 5 — Round stats tests
//
// Tests:
//   • getLastRoundStats() — correct counts for good / meh / snoozed / no response
//   • getLastRoundStats() — excludes the current round, returns previous
//   • getLastRoundStats() — returns null when no previous round
//   • Stats line format in channel announcement text
//
// Run: npm run test:post5

process.env.ADMIN_USER_IDS = 'UADMIN0';
process.env.DATABASE_PATH  = './data/test-post5.db';

const fs = require('node:fs');
fs.mkdirSync('./data', { recursive: true });
const dbPath = process.env.DATABASE_PATH;
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const { initDb }          = require('../src/db/init');
const { getDb }           = require('../src/db/connection');
const { getLastRoundStats } = require('../src/lib/rounds');

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

console.log('\n=== Phase 11 — Step 5: Round Stats Tests ===\n');

initDb();
const db = getDb();

// ── Helpers ───────────────────────────────────────────────────────────────────
function insertRound() {
  db.prepare(`INSERT INTO rounds (status, started_at, completed_at, created_by) VALUES ('completed', datetime('now'), datetime('now'), 'test')`).run();
  return db.prepare(`SELECT last_insert_rowid() AS id`).get().id;
}

function insertMatch(roundId, feedback = null) {
  db.prepare(`INSERT INTO matches (round_id, slack_dm_channel_id, feedback) VALUES (?, 'C_TEST', ?)`).run(roundId, feedback);
  return db.prepare(`SELECT last_insert_rowid() AS id`).get().id;
}

// ── No previous round ─────────────────────────────────────────────────────────
console.log('getLastRoundStats() — no previous round');
{
  const stats = getLastRoundStats(9999);
  check('returns null when no rounds exist', stats === null, stats);
}

// ── Round with all feedback types ─────────────────────────────────────────────
console.log('\ngetLastRoundStats() — mixed feedback');
{
  const r1 = insertRound();
  insertMatch(r1, 'good');
  insertMatch(r1, 'good');
  insertMatch(r1, 'meh');
  insertMatch(r1, 'snoozed');

  const stats = getLastRoundStats(9999); // exclude non-existent "current" round
  check('returns an object',            stats !== null);
  check('total is 4',                   stats?.total === 4,       stats?.total);
  check('met is 3 (good + meh)',        stats?.met   === 3,       stats?.met);
  check('snoozed is 1',                 stats?.snoozed === 1,     stats?.snoozed);
  check('pct is 75',                    stats?.pct   === 75,      stats?.pct);
  check('roundId is set',               stats?.roundId === r1,    stats?.roundId);
}

// ── Null feedback counts as "met" ─────────────────────────────────────────────
console.log('\ngetLastRoundStats() — no responses (all null feedback)');
{
  const r2 = insertRound();
  insertMatch(r2, null);
  insertMatch(r2, null);
  insertMatch(r2, null);

  const stats = getLastRoundStats(9999);
  // r2 is now the most recent round (9999 is excluded)
  check('total is 3',                   stats?.total === 3,       stats?.total);
  check('met is 3 (null = assumed met)', stats?.met  === 3,       stats?.met);
  check('snoozed is 0',                 stats?.snoozed === 0,     stats?.snoozed);
  check('pct is 100',                   stats?.pct   === 100,     stats?.pct);
}

// ── Excludes the current round ────────────────────────────────────────────────
console.log('\ngetLastRoundStats() — excludes current round');
{
  const r3 = insertRound(); // "current" round — just created, no feedback yet
  insertMatch(r3, null);
  insertMatch(r3, null);

  // When run.js calls getLastRoundStats(r3), it should see r2's data, not r3
  const stats = getLastRoundStats(r3);
  check('returns previous round (not current)', stats?.roundId !== r3, stats?.roundId);
  check('previous round has 3 matches',         stats?.total === 3,    stats?.total);
}

// ── 100% met ─────────────────────────────────────────────────────────────────
console.log('\ngetLastRoundStats() — 100% met');
{
  const r4 = insertRound();
  insertMatch(r4, 'good');
  insertMatch(r4, 'good');
  insertMatch(r4, 'meh');
  insertMatch(r4, 'good');

  const stats = getLastRoundStats(9999);
  check('met equals total',             stats?.met === stats?.total, `met=${stats?.met} total=${stats?.total}`);
  check('pct is 100',                   stats?.pct === 100,          stats?.pct);
  check('snoozed is 0',                 stats?.snoozed === 0,        stats?.snoozed);
}

// ── Stats line format ─────────────────────────────────────────────────────────
console.log('\nStats line format');
{
  // Simulate what run.js does to build the stats line
  function buildStatsLine(stats) {
    if (!stats) return '';
    const groupWord = stats.total === 1 ? 'group' : 'groups';
    return (
      `📊 *Last round:* ${stats.met} out of ${stats.total} ${groupWord} met` +
      ` — that's ${stats.pct}%! ☕\n\n`
    );
  }

  const line = buildStatsLine({ total: 4, met: 3, snoozed: 1, pct: 75 });
  check('contains emoji',               line.includes('📊'));
  check('contains met count',           line.includes('3'), line);
  check('contains total',               line.includes('4'), line);
  check('contains percentage',          line.includes('75%'), line);
  check('uses plural "groups"',         line.includes('groups'), line);

  const singular = buildStatsLine({ total: 1, met: 1, snoozed: 0, pct: 100 });
  check('uses singular "group" for 1',  singular.includes('1 group met'), singular);

  check('returns empty string for null', buildStatsLine(null) === '');
}

// ── Results ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(42)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(42));

try { fs.unlinkSync(dbPath); } catch (_) {}
if (failed > 0) process.exit(1);
