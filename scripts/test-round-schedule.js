'use strict';

// Round schedule tests — "when does this round end / the next one start?"
//
// lib/roundSchedule asks the scheduler's own rule (shouldRunNow) about each
// upcoming intro day, so its dates match when rounds really go out. Used by:
//   • the private full list of times — it stops when the round ends
//   • "the next round of intros goes out on …" in wrap-up messages, which used
//     to name the next Monday — wrong two weeks out of three on triweekly
//
// The scheduler ticks in the server's local time; prod's VM is Eastern.
process.env.TZ = 'America/New_York';
//
// Run: npm run test:round-schedule

const { initDb } = require('../src/db/init');
initDb();

const { nextRoundTime, getRoundEndDate } = require('../src/lib/roundSchedule');
const { shouldRunNow } = require('../src/scheduler');
const {
  calculateNextRoundDate, buildCompletionMessage, buildRoundSummaryMessage,
} = require('../src/integrations/meetingCompleter');
const { getDb } = require('../src/db/connection');

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

function cleanup() {
  getDb().exec(`DELETE FROM rounds WHERE created_by = 'test-roundsched'`);
}

// Prod's settings (Nov 2026).
const PROD = { cadence: 'triweekly', intro_day: 'monday', intro_time: '09:00' };
const WEEK_MS = 7 * 24 * 3600e3;
const iso = (d) => d?.toISOString();

/** The end must be a moment the scheduler would run, and no earlier intro slot may be. */
function agreesWithScheduler(settings, startedAt, end) {
  if (!shouldRunNow(settings.cadence, startedAt, end)) return false;
  const start = new Date(`${startedAt.replace(' ', 'T')}Z`);
  for (let t = end.getTime() - WEEK_MS; t > start.getTime(); t -= WEEK_MS) {
    if (shouldRunNow(settings.cadence, startedAt, t)) return false;
  }
  return true;
}

function endCheck(label, settings, startedAt, expectedIso) {
  const end = getRoundEndDate({ started_at: startedAt }, settings);
  check(`${label} → ${expectedIso}`, iso(end) === expectedIso, iso(end));
  if (end) check('  …and the scheduler agrees (runs then, not at any earlier intro slot)',
    agreesWithScheduler(settings, startedAt, end));
}

console.log('\n=== Round Schedule Tests ===');
cleanup();

console.log("\ngetRoundEndDate() — prod's real round history (triweekly, Monday 9:00 ET)");
endCheck('round 10 (Sep 14)', PROD, '2026-09-14 13:00:06', '2026-10-05T13:00:00.000Z');
endCheck('round 11 (Oct 5)',  PROD, '2026-10-05 13:00:03', '2026-10-26T13:00:00.000Z');
endCheck('round 12 (Oct 26) — across the Nov 1 clock change, 9:00 EST', PROD, '2026-10-26 13:00:15', '2026-11-16T14:00:00.000Z');
endCheck('round 13 (Nov 16, current)', PROD, '2026-11-16 14:00:41', '2026-12-07T14:00:00.000Z');

console.log('\ngetRoundEndDate() — other cadences (from a Mon Nov 16 9:00 ET start)');
endCheck('weekly',   { ...PROD, cadence: 'weekly' },   '2026-11-16 14:00:41', '2026-11-23T14:00:00.000Z');
endCheck('biweekly', { ...PROD, cadence: 'biweekly' }, '2026-11-16 14:00:41', '2026-11-30T14:00:00.000Z');
endCheck('monthly',  { ...PROD, cadence: 'monthly' },  '2026-11-16 14:00:41', '2026-12-14T14:00:00.000Z');
endCheck('unknown cadence (scheduler runs every intro day)', { ...PROD, cadence: 'fortnightly' },
  '2026-11-16 14:00:41', '2026-11-23T14:00:00.000Z');
endCheck('missing cadence (scheduler treats it as weekly)', { ...PROD, cadence: undefined },
  '2026-11-16 14:00:41', '2026-11-23T14:00:00.000Z');
endCheck('unknown cadence, round started Mon 8:00 AM → runs again at 9:00 the same morning',
  { ...PROD, cadence: 'fortnightly' }, '2026-11-16 13:00:00', '2026-11-16T14:00:00.000Z');

console.log('\ngetRoundEndDate() — rounds started by hand at odd times');
endCheck('triweekly started Wed 3 PM → Dec 7 is too soon, so Dec 14', PROD,
  '2026-11-18 20:00:00', '2026-12-14T14:00:00.000Z');
endCheck('weekly started Thu 10 AM → Nov 23 is too soon, so Nov 30', { ...PROD, cadence: 'weekly' },
  '2026-11-19 15:00:00', '2026-11-30T14:00:00.000Z');
endCheck('triweekly started Mon 8:55 AM → not the same morning', PROD,
  '2026-11-16 13:55:00', '2026-12-07T14:00:00.000Z');

console.log('\ngetRoundEndDate() — other intro settings');
endCheck('Friday 10:30, weekly', { cadence: 'weekly', intro_day: 'friday', intro_time: '10:30' },
  '2026-11-20 15:30:00', '2026-11-27T15:30:00.000Z');
endCheck('intro_day given as a number ("1" = Monday)', { ...PROD, intro_day: '1' },
  '2026-11-16 14:00:41', '2026-12-07T14:00:00.000Z');

console.log('\ngetRoundEndDate() / nextRoundTime() — edge cases');
{
  check('no round → null', getRoundEndDate(null, PROD) === null);
  check('round without started_at → null', getRoundEndDate({}, PROD) === null);
  check('ISO started_at also accepted',
    iso(getRoundEndDate({ started_at: '2026-11-16T14:00:41.000Z' }, PROD)) === '2026-12-07T14:00:00.000Z');
  check('never run before → the next intro slot',
    iso(nextRoundTime(PROD, null, new Date('2026-11-16T15:00:00Z'))) === '2026-11-23T14:00:00.000Z');
  check('overdue (last round 30+ days ago) → the next intro slot',
    iso(nextRoundTime(PROD, '2026-10-12 13:00:00', new Date('2026-11-17T15:00:00Z'))) === '2026-11-23T14:00:00.000Z');
  check('strictly after `after` (exactly Dec 7 9:00 → Dec 14)',
    iso(nextRoundTime(PROD, '2026-11-16 14:00:41', new Date('2026-12-07T14:00:00Z'))) === '2026-12-14T14:00:00.000Z');
  check('Eastern wall clock: always 9:00 AM on a Monday',
    [getRoundEndDate({ started_at: '2026-10-26 13:00:15' }, PROD), getRoundEndDate({ started_at: '2026-09-14 13:00:06' }, PROD)]
      .every((d) => d.getDay() === 1 && d.getHours() === 9 && d.getMinutes() === 0));
}

console.log('\ncalculateNextRoundDate() — "next round goes out on…" in wrap-up messages');
{
  // Make the current round (Nov 16) the latest completed one in this DB.
  getDb().prepare(`INSERT INTO rounds (status, started_at, completed_at, created_by)
                   VALUES ('completed', '2026-11-16 14:00:41', '2026-11-16 14:01:10', 'test-roundsched')`).run();

  const fromThu = calculateNextRoundDate(PROD, new Date('2026-11-19T17:00:00Z'));
  check('wrap-up sent Thu Nov 19 → Mon Dec 7 (was: Mon Nov 23)', iso(fromThu) === '2026-12-07T14:00:00.000Z', iso(fromThu));
  const fromWk2 = calculateNextRoundDate(PROD, new Date('2026-12-01T17:00:00Z'));
  check('wrap-up sent Tue Dec 1 → Mon Dec 7', iso(fromWk2) === '2026-12-07T14:00:00.000Z', iso(fromWk2));

  const text = buildCompletionMessage(1, fromThu, 'America/New_York', true)[0].text.text;
  check('completion message names Monday, Dec 7', text.includes('*Monday, Dec 7*'), text);
  const summary = buildRoundSummaryMessage(5, fromThu, 'America/New_York')[0].text.text;
  check('round summary names Monday, Dec 7', summary.includes('*Monday, Dec 7*'), summary);
}

cleanup();

console.log(`\n${'─'.repeat(42)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(42));
process.exit(failed > 0 ? 1 : 0);
