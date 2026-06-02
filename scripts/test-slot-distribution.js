'use strict';

// Slot distribution tests
//
// Tests:
//   • findSlotsWithPrimePreference() — prime-first ordering
//   • findSlotsWithPrimePreference() — 2-hour gap enforcement
//   • findSlotsWithPrimePreference() — fallback when prime window empty
//   • findSlotsWithPrimePreference() — fallback when gap too wide for prime
//   • buildNearWindow()  — starts +2 biz days, ends +4 biz days
//   • buildFarWindow()   — starts +5 biz days, ends +9 biz days
//   • Integration — near gives 2 slots, far gives 1, combined = 3
//
// Run: npm run test:slot-dist

const {
  findSlotsWithPrimePreference,
} = require('../src/lib/slotFinder');

const {
  buildNearWindow,
  buildFarWindow,
  addBusinessDays,
} = require('../src/integrations/calendarScheduler');

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

// ── Helpers ───────────────────────────────────────────────────────────────────

// Create a UTC Date for a given day offset from a Monday reference (2026-06-08 = Monday)
const MONDAY = new Date('2026-06-08T00:00:00Z');

function utcDate(dayOffset, hour, minute = 0) {
  const d = new Date(MONDAY);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

// Build a window [start, end] in UTC
function win(startDay, startHour, endDay, endHour) {
  return {
    start: utcDate(startDay, startHour),
    end:   utcDate(endDay, endHour),
  };
}

// Build noBusy data (everyone is free)
const noBusy = [];

// Build busy data that blocks a specific hour
function busyAt(dayOffset, startHour, endHour) {
  return [{ email: 'a@test.com', busySlots: [{
    start: utcDate(dayOffset, startHour),
    end:   utcDate(dayOffset, endHour),
  }] }];
}

console.log('\n=== Slot Distribution Tests ===\n');

// ── findSlotsWithPrimePreference — prime-first ordering ───────────────────────
console.log('findSlotsWithPrimePreference() — prime time preference');
{
  // Window: Mon 9 AM → Mon 5 PM UTC (UTC = same as local for these tests)
  const { start, end } = win(0, 9, 0, 17);
  const duration = 30;

  // Everyone free all day — prime slots (11-3) should come first in picks
  const slots = findSlotsWithPrimePreference(noBusy, start, end, duration, 2, 'UTC', 120);

  check('returns 2 slots',                         slots.length === 2, slots.length);
  check('slots are in chronological order',        slots[0].start < slots[1].start);

  const h0 = slots[0].start.getUTCHours() + slots[0].start.getUTCMinutes() / 60;
  const h1 = slots[1].start.getUTCHours() + slots[1].start.getUTCMinutes() / 60;
  check('first slot is in prime time (≥11)',        h0 >= 11, h0);
  check('second slot is in prime time (≥11)',       h1 >= 11, h1);
  check('second slot ≥ 2h after first',            h1 - h0 >= 2, `${h0} → ${h1}`);
}

// ── 2-hour gap enforcement ─────────────────────────────────────────────────────
console.log('\nfindSlotsWithPrimePreference() — 2-hour gap');
{
  const { start, end } = win(0, 9, 0, 17);

  const slots = findSlotsWithPrimePreference(noBusy, start, end, 30, 2, 'UTC', 120);
  check('returns 2 slots',                         slots.length === 2, slots.length);

  const gapMinutes = (slots[1].start - slots[0].start) / 60000;
  check('gap between starts is ≥ 120 minutes',     gapMinutes >= 120, gapMinutes);
}

// ── Fallback when prime window is fully busy ──────────────────────────────────
console.log('\nfindSlotsWithPrimePreference() — fallback when prime blocked');
{
  // Block the entire prime window (11 AM–3 PM)
  const busyPrime = [{ email: 'a@test.com', busySlots: [{
    start: utcDate(0, 11),
    end:   utcDate(0, 15),
  }] }];
  const { start, end } = win(0, 9, 0, 17);

  const slots = findSlotsWithPrimePreference(busyPrime, start, end, 30, 2, 'UTC', 120);
  check('still returns 2 slots from fallback',     slots.length === 2, slots.length);
  check('slots are in chronological order',        slots[0].start < slots[1].start);

  const h0 = slots[0].start.getUTCHours();
  const h1 = slots[1].start.getUTCHours();
  check('first slot is before 11 AM (fallback)',   h0 < 11, h0);
  check('gap still ≥ 2 hours',                     (slots[1].start - slots[0].start) / 60000 >= 120);
}

// ── maxCount: 1 (far window use case) ────────────────────────────────────────
console.log('\nfindSlotsWithPrimePreference() — maxCount 1 (far window)');
{
  const { start, end } = win(7, 9, 11, 17); // following Mon–Wed

  const slots = findSlotsWithPrimePreference(noBusy, start, end, 15, 1, 'UTC', 0);
  check('returns exactly 1 slot',                  slots.length === 1, slots.length);

  const h = slots[0].start.getUTCHours() + slots[0].start.getUTCMinutes() / 60;
  check('slot is in prime time',                   h >= 11, h);
}

// ── Empty window ──────────────────────────────────────────────────────────────
console.log('\nfindSlotsWithPrimePreference() — empty window');
{
  // Everyone busy all day
  const allBusy = [{ email: 'a@test.com', busySlots: [{
    start: utcDate(0, 0),
    end:   utcDate(1, 0),
  }] }];
  const { start, end } = win(0, 9, 0, 17);

  const slots = findSlotsWithPrimePreference(allBusy, start, end, 30, 2, 'UTC', 120);
  check('returns empty array when fully blocked',  slots.length === 0, slots.length);
}

// ── buildNearWindow ───────────────────────────────────────────────────────────
console.log('\nbuildNearWindow()');
{
  // Monday Jun 8 as reference
  const near = buildNearWindow(MONDAY, 'UTC');

  check('start is a Date',                         near.start instanceof Date);
  check('end is a Date',                           near.end instanceof Date);
  check('start is a weekday',                      ![0,6].includes(near.start.getUTCDay()));
  check('start is at 09:00 UTC',                   near.start.getUTCHours() === 9 && near.start.getUTCMinutes() === 0);
  check('end is at 17:00 UTC',                     near.end.getUTCHours() === 17 && near.end.getUTCMinutes() === 0);
  check('start is +2 biz days (Wednesday)',        near.start.getUTCDay() === 3, near.start.toDateString());

  // Window spans Wed–Fri (3 business days)
  const windowDays = (near.end - near.start) / (1000 * 60 * 60 * 24);
  check('window is ~2–3 calendar days wide',       windowDays >= 2 && windowDays <= 3, windowDays);
}

// ── buildFarWindow ────────────────────────────────────────────────────────────
console.log('\nbuildFarWindow()');
{
  const far = buildFarWindow(MONDAY, 'UTC');

  check('start is a Date',                         far.start instanceof Date);
  check('end is a Date',                           far.end instanceof Date);
  check('start is a weekday',                      ![0,6].includes(far.start.getUTCDay()));
  check('start is at 09:00 UTC',                   far.start.getUTCHours() === 9);
  check('end is at 17:00 UTC',                     far.end.getUTCHours() === 17);
  check('start is +5 biz days (following Monday)', far.start.getUTCDay() === 1, far.start.toDateString());
  check('far starts after near ends',              far.start > buildNearWindow(MONDAY, 'UTC').end);
}

// ── Integration: near gives 2, far gives 1 ───────────────────────────────────
console.log('\nIntegration — near 2 + far 1');
{
  const near = buildNearWindow(MONDAY, 'UTC');
  const far  = buildFarWindow(MONDAY, 'UTC');

  // Everyone free across both windows
  const nearSlots = findSlotsWithPrimePreference(noBusy, near.start, near.end, 15, 2, 'UTC', 120);
  const farSlots  = findSlotsWithPrimePreference(noBusy, far.start,  far.end,  15, 1, 'UTC',   0);
  const combined  = [...nearSlots, ...farSlots];

  check('near window returns 2 slots',             nearSlots.length === 2, nearSlots.length);
  check('far window returns 1 slot',               farSlots.length === 1,  farSlots.length);
  check('combined total is 3 slots',               combined.length === 3,  combined.length);
  check('far slot is after all near slots',        farSlots[0].start > nearSlots[1].start);
  check('all 3 are in prime time (11–3)',
    combined.every(s => {
      const h = s.start.getUTCHours() + s.start.getUTCMinutes() / 60;
      return h >= 11 && h < 15;
    })
  );

  // Near gap ≥ 2 hours
  const nearGap = (nearSlots[1].start - nearSlots[0].start) / 60000;
  check('near slots are ≥ 2 hours apart',          nearGap >= 120, nearGap);
}

// ── Results ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(42)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(42));

if (failed > 0) process.exit(1);
