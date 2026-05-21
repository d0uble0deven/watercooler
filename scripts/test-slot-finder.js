'use strict';

// Phase 10 Step 4 — Slot finder unit tests
//
// Pure-function tests — no DB, no network, no Azure credentials.
// All fixtures use a Monday 9 AM–5 PM UTC window for clarity.
//
// Run: npm run test:slot-finder

const { findSlots, isWithinWorkday, overlapsAny } = require('../src/lib/slotFinder');

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

// Build a Date for Monday 2025-06-09 at a given UTC hour (and optional minutes)
function mon(hour, minute = 0) {
  return new Date(`2025-06-09T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
}
// Tuesday 2025-06-10
function tue(hour, minute = 0) {
  return new Date(`2025-06-10T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
}

const DAY_START = mon(9);   // 9 AM
const DAY_END   = mon(17);  // 5 PM
const DURATION  = 30;       // minutes

function busy(startDate, endDate) {
  return { start: startDate, end: endDate, status: 'busy' };
}
function userData(email, slots) {
  return { email, busySlots: slots };
}

// ── isWithinWorkday ───────────────────────────────────────────────────────────
console.log('\n=== Phase 10 — Step 4: Slot Finder Tests ===\n');
console.log('isWithinWorkday()');
{
  check('9:00–9:30 is within 9–17',     isWithinWorkday(mon(9),    mon(9,30),  9, 17));
  check('16:30–17:00 is within 9–17',   isWithinWorkday(mon(16,30),mon(17),    9, 17));
  check('8:30–9:00 is NOT within 9–17', !isWithinWorkday(mon(8,30),mon(9),     9, 17));
  check('17:00–17:30 is NOT within 9–17',!isWithinWorkday(mon(17), mon(17,30), 9, 17));
  check('8:00–8:30 is NOT within 9–17', !isWithinWorkday(mon(8),   mon(8,30),  9, 17));
  check('9:00–9:45 is within 9–17',     isWithinWorkday(mon(9),    mon(9,45),  9, 17));
  check('16:31–17:01 is NOT within 9–17',!isWithinWorkday(mon(16,31),new Date(mon(17).getTime()+60000), 9, 17));
  // Overnight guard: 23:30 Mon → 00:00 Tue must NOT be treated as workday
  check('23:30–00:00 overnight NOT within 9–17', !isWithinWorkday(mon(23,30), tue(0), 9, 17));
}

// ── overlapsAny ───────────────────────────────────────────────────────────────
console.log('\noverlapsAny()');
{
  const busy10to11 = [busy(mon(10), mon(11))];
  check('slot fully inside busy → overlap',       overlapsAny(mon(10,15), mon(10,45), busy10to11));
  check('slot starts inside busy → overlap',      overlapsAny(mon(10,30), mon(11,30), busy10to11));
  check('slot ends inside busy → overlap',        overlapsAny(mon(9,30),  mon(10,30), busy10to11));
  check('slot wraps busy entirely → overlap',     overlapsAny(mon(9,30),  mon(11,30), busy10to11));
  check('slot ends at busy start → no overlap',   !overlapsAny(mon(9),    mon(10),    busy10to11));
  check('slot starts at busy end → no overlap',   !overlapsAny(mon(11),   mon(11,30), busy10to11));
  check('slot before busy → no overlap',          !overlapsAny(mon(9),    mon(9,30),  busy10to11));
  check('slot after busy → no overlap',           !overlapsAny(mon(11,30),mon(12),    busy10to11));
  check('empty busy list → no overlap',           !overlapsAny(mon(10),   mon(10,30), []));
}

// ── findSlots — basic ─────────────────────────────────────────────────────────
console.log('\nfindSlots() — no busy data');
{
  const slots = findSlots([], DAY_START, DAY_END, DURATION);
  check('returns 3 slots (default maxSlots)',   slots.length === 3, slots.length);
  check('first slot starts at 9:00 AM',         slots[0].start.getTime() === mon(9).getTime());
  check('first slot ends at 9:30 AM',           slots[0].end.getTime()   === mon(9,30).getTime());
  check('second slot starts at 9:30 AM',        slots[1].start.getTime() === mon(9,30).getTime());
  check('third slot starts at 10:00 AM',        slots[2].start.getTime() === mon(10).getTime());
  check('all slots are Date objects',            slots.every((s) => s.start instanceof Date && s.end instanceof Date));
}

// ── findSlots — single user busy at first slot ────────────────────────────────
console.log('\nfindSlots() — one user busy at 9:00–9:30');
{
  const data  = [userData('alice@co.com', [busy(mon(9), mon(9,30))])];
  const slots = findSlots(data, DAY_START, DAY_END, DURATION);
  check('9:00 slot skipped',              slots[0].start.getTime() !== mon(9).getTime());
  check('first result is 9:30 AM',        slots[0].start.getTime() === mon(9,30).getTime());
  check('still returns 3 slots total',    slots.length === 3, slots.length);
}

// ── findSlots — two users, combined busy times ────────────────────────────────
console.log('\nfindSlots() — two users with non-overlapping busy times');
{
  const data = [
    userData('alice@co.com', [busy(mon(9),    mon(9,30))]),   // 9:00–9:30
    userData('bob@co.com',   [busy(mon(9,30), mon(10))]),     // 9:30–10:00
  ];
  const slots = findSlots(data, DAY_START, DAY_END, DURATION);
  check('9:00 and 9:30 both skipped',   slots[0].start.getTime() === mon(10).getTime());
  check('first free slot is 10:00 AM',  slots[0].start.getTime() === mon(10).getTime());
}

// ── findSlots — partial overlap still blocks ──────────────────────────────────
console.log('\nfindSlots() — partial overlap still blocks slot');
{
  // Busy 10:15–11:15 should block both 10:00–10:30 and 10:30–11:00 and 11:00–11:30... wait:
  // 10:00–10:30: overlaps 10:15–11:15? 10:00 < 11:15 && 10:15 < 10:30 → YES → blocked
  // 10:30–11:00: overlaps 10:15–11:15? 10:30 < 11:15 && 10:15 < 11:00 → YES → blocked
  // 11:00–11:30: overlaps 10:15–11:15? 11:00 < 11:15 && 10:15 < 11:30 → YES → blocked
  // 11:30–12:00: overlaps 10:15–11:15? 11:30 < 11:15? NO → free ✓
  const data  = [userData('alice@co.com', [busy(mon(10,15), mon(11,15))])];
  const slots = findSlots(data, DAY_START, DAY_END, DURATION);
  const startTimes = slots.map((s) => s.start.getUTCHours() + ':' + String(s.start.getUTCMinutes()).padStart(2,'0'));
  check('9:00 is free (before busy)',         slots.some((s) => s.start.getTime() === mon(9).getTime()));
  check('10:00 is blocked (partial overlap)', !slots.some((s) => s.start.getTime() === mon(10).getTime()));
  check('10:30 is blocked (partial overlap)', !slots.some((s) => s.start.getTime() === mon(10,30).getTime()));
  check('11:30 is free (after busy)',         slots.some((s) => s.start.getTime() === mon(11,30).getTime()));
}

// ── findSlots — respects maxSlots ─────────────────────────────────────────────
console.log('\nfindSlots() — maxSlots option');
{
  const s1 = findSlots([], DAY_START, DAY_END, DURATION, { maxSlots: 1 });
  const s5 = findSlots([], DAY_START, DAY_END, DURATION, { maxSlots: 5 });
  check('maxSlots: 1 returns exactly 1',  s1.length === 1, s1.length);
  check('maxSlots: 5 returns exactly 5',  s5.length === 5, s5.length);
}

// ── findSlots — respects workday boundaries ───────────────────────────────────
console.log('\nfindSlots() — workday boundary enforcement');
{
  // Window starts at 8 AM but workday starts at 9 AM
  const earlyStart = mon(8);
  const slots = findSlots([], earlyStart, DAY_END, DURATION);
  check('no slot before 9 AM',   slots.every((s) => s.start.getUTCHours() >= 9));
  check('first slot is 9:00 AM', slots[0].start.getTime() === mon(9).getTime());

  // Slot ending past 5 PM should not be offered
  const lateSlots = findSlots([], DAY_START, DAY_END, DURATION, { maxSlots: 20 });
  check('no slot ending past 5 PM', lateSlots.every((s) => {
    const endH = s.end.getUTCHours() + s.end.getUTCMinutes() / 60;
    return endH <= 17;
  }));
  // Last possible 30-min slot is 16:30–17:00
  const lastSlot = lateSlots[lateSlots.length - 1];
  check('last slot ends at exactly 5 PM', lastSlot.end.getTime() === mon(17).getTime());
}

// ── findSlots — meeting duration affects results ──────────────────────────────
console.log('\nfindSlots() — meeting duration (60 min)');
{
  // With a 60-min slot, the gap must be at least 60 min.
  // Busy 10:00–10:30 blocks 9:30–10:30 and 10:00–11:00, but not 9:00–10:00.
  const data  = [userData('alice@co.com', [busy(mon(10), mon(10,30))])];
  const slots = findSlots(data, DAY_START, DAY_END, 60, { slotIntervalMinutes: 30 });
  check('9:00–10:00 is offered (60 min, free)',   slots[0].start.getTime() === mon(9).getTime());
  check('each slot is 60 minutes long',           slots.every((s) => s.end - s.start === 60 * 60 * 1000));
  check('9:30–10:30 is blocked (overlaps busy)',  !slots.some((s) => s.start.getTime() === mon(9,30).getTime()));
}

// ── findSlots — entirely busy day ─────────────────────────────────────────────
console.log('\nfindSlots() — no available slots');
{
  // One busy block covers the whole workday
  const data  = [userData('alice@co.com', [busy(mon(9), mon(17))])];
  const slots = findSlots(data, DAY_START, DAY_END, DURATION);
  check('returns empty array when all busy', slots.length === 0, slots.length);
}

// ── findSlots — multi-day window ──────────────────────────────────────────────
console.log('\nfindSlots() — multi-day window (Mon full, finds slots Tue)');
{
  // Monday is entirely busy; Tuesday should have free slots
  const data  = [userData('alice@co.com', [busy(mon(9), mon(17))])];
  const slots = findSlots(data, DAY_START, tue(17), DURATION, { maxSlots: 3 });
  check('skips Monday (all busy)',         slots.every((s) => s.start >= tue(0)));
  check('finds slots on Tuesday',          slots.length === 3, slots.length);
  check('Tuesday first slot at 9:00 AM',   slots[0].start.getTime() === tue(9).getTime());
}

// ── findSlots — null / empty guards ──────────────────────────────────────────
console.log('\nfindSlots() — null / empty inputs');
{
  const r1 = findSlots(null, DAY_START, DAY_END, DURATION);
  check('null busyData → treated as no conflicts',  r1.length === 3, r1.length);

  const r2 = findSlots([userData('a@b.com', null)], DAY_START, DAY_END, DURATION);
  check('null busySlots entry → no crash',           r2.length === 3, r2.length);

  const r3 = findSlots([], mon(17), mon(17), DURATION);
  check('zero-length window → empty array',          r3.length === 0, r3.length);
}

// ── Results ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(42)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(42));

if (failed > 0) process.exit(1);
