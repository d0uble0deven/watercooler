'use strict';

// Feature C — timezone intersection tests
//
// Tests:
//   • WINDOWS_TO_IANA — spot checks for common US zones
//   • computeIntersection() — single timezone
//   • computeIntersection() — ET + CT intersection (summer)
//   • computeIntersection() — prime overlap falls back to full workday when none
//   • computeIntersection() — empty array → null
//   • buildNearWindow() with intersection — uses UTC bounds
//   • buildFarWindow()  with intersection — uses UTC bounds
//   • buildNearWindow() without intersection — backward compat (local tz)
//   • pickDisplayTimezone() — same zone, mixed zones, empty
//   • Integration — two CT users: 2 near + 1 far, all in CDT prime time
//
// Run: npm run test:tz-inter

const {
  computeIntersection,
  buildNearWindow,
  buildFarWindow,
  pickDisplayTimezone,
  WINDOWS_TO_IANA,
} = require('../src/integrations/calendarScheduler');

const { findSlotsWithPrimePreference } = require('../src/lib/slotFinder');

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

// ── Reference date ─────────────────────────────────────────────────────────────
// Monday 2026-06-08 — summer, so CDT = UTC-5, EDT = UTC-4
const MONDAY = new Date('2026-06-08T12:00:00Z');

console.log('\n=== Timezone Intersection Tests ===\n');

// ── WINDOWS_TO_IANA spot checks ────────────────────────────────────────────────
console.log('WINDOWS_TO_IANA — lookup table');
{
  check('Eastern Standard Time → America/New_York',
    WINDOWS_TO_IANA['Eastern Standard Time'] === 'America/New_York');
  check('Central Standard Time → America/Chicago',
    WINDOWS_TO_IANA['Central Standard Time'] === 'America/Chicago');
  check('Pacific Standard Time → America/Los_Angeles',
    WINDOWS_TO_IANA['Pacific Standard Time'] === 'America/Los_Angeles');
  check('US Mountain Standard Time → America/Phoenix (no DST)',
    WINDOWS_TO_IANA['US Mountain Standard Time'] === 'America/Phoenix');
  check('unknown key → undefined (not a crash)',
    WINDOWS_TO_IANA['Atlantis Standard Time'] === undefined);
}

// ── computeIntersection — single ET user ───────────────────────────────────────
console.log('\ncomputeIntersection() — single ET user (summer EDT = UTC-4)');
{
  const result = computeIntersection(['America/New_York'], MONDAY);

  check('returns an object (not null)',  result !== null, result);
  check('timezoneId is UTC',            result?.timezoneId === 'UTC');
  check('workdayStartHour = 13 (9am EDT → 13:00 UTC)',
    result?.workdayStartHour === 13, result?.workdayStartHour);
  check('workdayEndHour   = 21 (5pm EDT → 21:00 UTC)',
    result?.workdayEndHour   === 21, result?.workdayEndHour);
  check('primeStartHour   = 15 (11am EDT → 15:00 UTC)',
    result?.primeStartHour   === 15, result?.primeStartHour);
  check('primeEndHour     = 19 (3pm EDT → 19:00 UTC)',
    result?.primeEndHour     === 19, result?.primeEndHour);
}

// ── computeIntersection — ET + CT ─────────────────────────────────────────────
console.log('\ncomputeIntersection() — ET + CT intersection (summer)');
{
  // ET: workday 13–21 UTC, prime 15–19 UTC
  // CT: workday 14–22 UTC, prime 16–20 UTC
  // Intersection: workday 14–21, prime 16–19
  const result = computeIntersection(['America/New_York', 'America/Chicago'], MONDAY);

  check('returns an object (not null)',  result !== null, result);
  check('workdayStartHour = 14 (10am ET = 9am CT)',
    result?.workdayStartHour === 14, result?.workdayStartHour);
  check('workdayEndHour   = 21 (5pm ET = 4pm CT)',
    result?.workdayEndHour   === 21, result?.workdayEndHour);
  check('primeStartHour   = 16 (noon ET = 11am CT)',
    result?.primeStartHour   === 16, result?.primeStartHour);
  check('primeEndHour     = 19 (3pm ET = 2pm CT)',
    result?.primeEndHour     === 19, result?.primeEndHour);
}

// ── computeIntersection — no prime overlap → widens to full workday ────────────
console.log('\ncomputeIntersection() — no prime overlap falls back to workday bounds');
{
  // ET prime: 15–19 UTC.  HI prime: 21–01 UTC (11am–3pm HST = UTC-10).
  // Overlap: none → should widen prime to full workday intersection.
  // ET workday: 13–21 UTC.  HI workday: 19–03 UTC.  Intersection: 19–21 (narrow but non-zero).
  // ET prime [15,19] ∩ HI prime [21,01] — 21 >= 19 so no overlap → fall back
  const result = computeIntersection(['America/New_York', 'Pacific/Honolulu'], MONDAY);

  check('returns object (workday hours overlap exists)',  result !== null, result);
  if (result) {
    const primeWideToWorkday = (
      result.primeStartHour === result.workdayStartHour &&
      result.primeEndHour   === result.workdayEndHour
    );
    check('prime bounds widen to full workday when no prime overlap', primeWideToWorkday,
      { prime: [result.primeStartHour, result.primeEndHour], workday: [result.workdayStartHour, result.workdayEndHour] });
  }
}

// ── computeIntersection — empty array → null ──────────────────────────────────
console.log('\ncomputeIntersection() — empty array');
{
  check('returns null for empty array', computeIntersection([], MONDAY) === null);
  check('returns null for null input',  computeIntersection(null, MONDAY) === null);
}

// ── buildNearWindow with intersection ─────────────────────────────────────────
console.log('\nbuildNearWindow() — with ET+CT intersection');
{
  const inter = computeIntersection(['America/New_York', 'America/Chicago'], MONDAY);
  const near  = buildNearWindow(MONDAY, 'America/New_York', inter);

  check('start is a Date',             near.start instanceof Date);
  check('end   is a Date',             near.end   instanceof Date);
  check('start UTC hour = 14 (9am CT)',  near.start.getUTCHours() === 14, near.start.toISOString());
  check('end   UTC hour = 21 (5pm ET)',  near.end.getUTCHours()   === 21, near.end.toISOString());
  check('start is Wednesday (+2 biz days)', near.start.getUTCDay() === 3, near.start.toDateString());
  check('end   is Friday   (+4 biz days)', near.end.getUTCDay()   === 5, near.end.toDateString());
}

// ── buildFarWindow with intersection ──────────────────────────────────────────
console.log('\nbuildFarWindow() — with ET+CT intersection');
{
  const inter = computeIntersection(['America/New_York', 'America/Chicago'], MONDAY);
  const far   = buildFarWindow(MONDAY, 'America/New_York', inter);

  check('start UTC hour = 14', far.start.getUTCHours() === 14, far.start.toISOString());
  check('end   UTC hour = 21', far.end.getUTCHours()   === 21, far.end.toISOString());
  check('start is following Monday (+5 biz days)', far.start.getUTCDay() === 1, far.start.toDateString());
  check('far starts after near ends',
    far.start > buildNearWindow(MONDAY, 'America/New_York', inter).end);
}

// ── buildNearWindow without intersection (backward compat) ────────────────────
console.log('\nbuildNearWindow() — no intersection (org-tz fallback)');
{
  const near = buildNearWindow(MONDAY, 'UTC');

  check('start UTC hour = 9  (9am UTC, no intersection)', near.start.getUTCHours() === 9,  near.start.toISOString());
  check('end   UTC hour = 17 (5pm UTC, no intersection)', near.end.getUTCHours()   === 17, near.end.toISOString());
  check('start is Wednesday', near.start.getUTCDay() === 3);
}

// ── pickDisplayTimezone ───────────────────────────────────────────────────────
console.log('\npickDisplayTimezone()');
{
  check('same zone → use participant zone',
    pickDisplayTimezone(['America/Chicago', 'America/Chicago'], 'America/New_York') === 'America/Chicago');
  check('mixed zones → use org timezone',
    pickDisplayTimezone(['America/New_York', 'America/Chicago'], 'America/New_York') === 'America/New_York');
  check('empty array → use org timezone',
    pickDisplayTimezone([], 'America/New_York') === 'America/New_York');
  check('single zone → use that zone',
    pickDisplayTimezone(['America/Los_Angeles'], 'America/New_York') === 'America/Los_Angeles');
}

// ── Integration — two CT users ────────────────────────────────────────────────
console.log('\nIntegration — two CT users: 2 near + 1 far in CDT prime time');
{
  const tzs        = ['America/Chicago', 'America/Chicago'];
  const inter      = computeIntersection(tzs, MONDAY);
  const near       = buildNearWindow(MONDAY, 'America/New_York', inter);
  const far        = buildFarWindow(MONDAY,  'America/New_York', inter);
  const displayTz  = pickDisplayTimezone(tzs, 'America/New_York');

  check('displayTz = America/Chicago (both users CT)', displayTz === 'America/Chicago');

  // CT intersection: workday 14–22 UTC, prime 16–20 UTC
  check('near window start = 14:00 UTC (9am CDT)', near.start.getUTCHours() === 14, near.start.toISOString());
  check('near window end   = 22:00 UTC (5pm CDT)', near.end.getUTCHours()   === 22, near.end.toISOString());

  const nearSlots = findSlotsWithPrimePreference(
    [], near.start, near.end, 30, 2, inter.timezoneId, 120, inter,
  );
  const farSlots = findSlotsWithPrimePreference(
    [], far.start,  far.end,  30, 1, inter.timezoneId,   0, inter,
  );
  const combined = [...nearSlots, ...farSlots];

  check('near gives 2 slots',    nearSlots.length === 2, nearSlots.length);
  check('far  gives 1 slot',     farSlots.length  === 1, farSlots.length);
  check('combined total is 3',   combined.length  === 3, combined.length);

  const nearGap = (nearSlots[1].start - nearSlots[0].start) / 60000;
  check('near gap ≥ 2 hours',    nearGap >= 120, nearGap);

  // All slots should be in CDT prime time (11am–3pm CDT = 16:00–20:00 UTC)
  const allPrime = combined.every((s) => {
    const h = s.start.getUTCHours() + s.start.getUTCMinutes() / 60;
    return h >= 16 && h < 20;
  });
  check('all 3 slots in CDT prime time (11am–3pm)', allPrime,
    combined.map((s) => s.start.toISOString()));

  check('far slot is after all near slots', farSlots[0].start > nearSlots[1].start);

  // Confirm the first near slot label would show in CDT
  const label0UtcHour = nearSlots[0].start.getUTCHours();
  check('near[0] starts at 16:00 UTC (11:00 AM CDT)', label0UtcHour === 16, label0UtcHour);
}

// ── Results ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(42)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(42));

if (failed > 0) process.exit(1);
