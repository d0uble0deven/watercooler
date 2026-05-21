'use strict';

// Phase 8 — Scheduler smoke test
//
// Tests the pure helper functions in src/scheduler/index.js and the two new
// `set` sub-commands (intro-day, intro-time) without needing Slack or a cron tick.
//
// Run: npm run test:scheduler

// ── env before any require() ──────────────────────────────────────────────────
process.env.ADMIN_USER_IDS  = 'UADMIN0';
process.env.DATABASE_PATH   = './data/test-scheduler.db';
process.env.SCHEDULING_ENABLED = 'false'; // scheduler must not actually start

const fs = require('node:fs');

fs.mkdirSync('./data', { recursive: true });
const dbPath = process.env.DATABASE_PATH;
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const { initDb }     = require('../src/db/init');
const { handleAdmin } = require('../src/commands/admin/index');
const {
  parseDayToNumber,
  parseTime,
  shouldRunNow,
  startScheduler,
} = require('../src/scheduler/index');

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label, condition, actual) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    console.error(`     Got: ${JSON.stringify(actual)}`);
    failed++;
  }
}

async function runCmd(text) {
  let response = null;
  await handleAdmin({ user_id: 'UADMIN0' }, text, async (msg) => { response = msg; }, null);
  return response;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  initDb();

  console.log('\n=== Phase 8 Scheduler Tests ===\n');

  // ── parseDayToNumber ──────────────────────────────────────────────────────
  console.log('parseDayToNumber');
  {
    check('monday  → 1',      parseDayToNumber('monday')    === 1);
    check('tuesday → 2',      parseDayToNumber('tuesday')   === 2);
    check('sunday  → 0',      parseDayToNumber('sunday')    === 0);
    check('saturday → 6',     parseDayToNumber('saturday')  === 6);
    check('MONDAY (mixed case)', parseDayToNumber('MONDAY') === 1);
    check('numeric string "3"',  parseDayToNumber('3')      === 3);
    check('number 5',            parseDayToNumber(5)        === 5);
    check('unknown → Monday(1)', parseDayToNumber('holiday') === 1);
  }

  // ── parseTime ─────────────────────────────────────────────────────────────
  console.log('\nparseTime');
  {
    const t1 = parseTime('09:00');
    check('09:00 → hour=9 minute=0', t1.hour === 9 && t1.minute === 0, t1);

    const t2 = parseTime('14:30');
    check('14:30 → hour=14 minute=30', t2.hour === 14 && t2.minute === 30, t2);

    const t3 = parseTime('00:00');
    check('00:00 → hour=0 minute=0', t3.hour === 0 && t3.minute === 0, t3);

    const t4 = parseTime('23:59');
    check('23:59 → hour=23 minute=59', t4.hour === 23 && t4.minute === 59, t4);

    const tBad = parseTime(null);
    check('null falls back to 09:00', tBad.hour === 9 && tBad.minute === 0, tBad);

    const tBad2 = parseTime('bad');
    check('garbage falls back to 09:00', tBad2.hour === 9 && tBad2.minute === 0, tBad2);
  }

  // ── shouldRunNow ─────────────────────────────────────────────────────────
  console.log('\nshouldRunNow');
  {
    // Never run before → always go
    check('weekly,  never run → true',    shouldRunNow('weekly',   null) === true);
    check('biweekly, never run → true',   shouldRunNow('biweekly', null) === true);
    check('monthly,  never run → true',   shouldRunNow('monthly',  null) === true);

    // Ran 7 days ago (past grace window)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    check('weekly,  7 days ago → true',    shouldRunNow('weekly',   sevenDaysAgo) === true);
    check('biweekly, 7 days ago → false',  shouldRunNow('biweekly', sevenDaysAgo) === false);
    check('monthly,  7 days ago → false',  shouldRunNow('monthly',  sevenDaysAgo) === false);

    // Ran 14 days ago
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    check('biweekly,   14 days ago → true',  shouldRunNow('biweekly',   fourteenDaysAgo) === true);
    check('triweekly,  14 days ago → false', shouldRunNow('triweekly',  fourteenDaysAgo) === false);
    check('monthly,    14 days ago → false', shouldRunNow('monthly',    fourteenDaysAgo) === false);

    // Ran 21 days ago
    const twentyOneDaysAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
    check('triweekly,  21 days ago → true',  shouldRunNow('triweekly',  twentyOneDaysAgo) === true);
    check('monthly,    21 days ago → false', shouldRunNow('monthly',    twentyOneDaysAgo) === false);

    // Ran 28 days ago
    const twentyEightDaysAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
    check('monthly, 28 days ago → true',   shouldRunNow('monthly', twentyEightDaysAgo) === true);

    // Ran 1 day ago — all cadences should block
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    check('weekly,  1 day ago → false',   shouldRunNow('weekly',   oneDayAgo) === false);
    check('biweekly, 1 day ago → false',  shouldRunNow('biweekly', oneDayAgo) === false);
    check('monthly,  1 day ago → false',  shouldRunNow('monthly',  oneDayAgo) === false);

    // Unknown cadence → always run (permissive default)
    check('unknown cadence → true',       shouldRunNow('fortnightly', null) === true);
  }

  // ── startScheduler (disabled) ────────────────────────────────────────────
  console.log('\nstartScheduler (disabled)');
  {
    // SCHEDULING_ENABLED=false — should return without throwing or starting anything
    let threw = false;
    try {
      startScheduler({ client: null });
    } catch (err) {
      threw = true;
    }
    check('does not throw when disabled', !threw);
  }

  // ── set intro-day (via admin command) ────────────────────────────────────
  console.log('\nset intro-day');
  {
    const ok = await runCmd('set intro-day wednesday');
    check('accepts wednesday',          ok.includes('✅') && ok.includes('wednesday'), ok);

    const ok2 = await runCmd('set intro-day friday');
    check('accepts friday',             ok2.includes('✅') && ok2.includes('friday'), ok2);

    const bad1 = await runCmd('set intro-day holiday');
    check('rejects unknown day',        bad1.includes('❌'), bad1);

    const bad2 = await runCmd('set intro-day');
    check('rejects missing day arg',    bad2.includes('❌'), bad2);
  }

  // ── set intro-time (via admin command) ───────────────────────────────────
  console.log('\nset intro-time');
  {
    const ok1 = await runCmd('set intro-time 09:00');
    check('accepts 09:00',              ok1.includes('✅') && ok1.includes('09:00'), ok1);

    const ok2 = await runCmd('set intro-time 14:30');
    check('accepts 14:30',              ok2.includes('✅') && ok2.includes('14:30'), ok2);

    const ok3 = await runCmd('set intro-time 0:00');
    check('accepts single-digit hour',  ok3.includes('✅') && ok3.includes('00:00'), ok3);

    const bad1 = await runCmd('set intro-time 25:00');
    check('rejects hour > 23',          bad1.includes('❌'), bad1);

    const bad2 = await runCmd('set intro-time 09:60');
    check('rejects minute > 59',        bad2.includes('❌'), bad2);

    const bad3 = await runCmd('set intro-time 9am');
    check('rejects non-HH:MM format',   bad3.includes('❌'), bad3);

    const bad4 = await runCmd('set intro-time');
    check('rejects missing time arg',   bad4.includes('❌'), bad4);
  }

  // ── settings shows intro-day and intro-time ───────────────────────────────
  console.log('\nsettings reflects updates');
  {
    await runCmd('set intro-day tuesday');
    await runCmd('set intro-time 10:15');
    const r = await runCmd('settings');
    check('intro-day shown',  r.includes('Intro day'), r);
    check('intro-time shown', r.includes('Intro time'), r);
  }

  // ── Results ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));

  try { fs.unlinkSync(dbPath); } catch (_) {}

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
