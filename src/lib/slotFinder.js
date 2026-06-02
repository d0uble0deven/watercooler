'use strict';

// Finds available meeting slots within a time window, given the busy schedules
// of all participants in a match group.
//
// Pure function — no network calls, no DB reads. Accepts the normalised output
// from calendarReader.getFreeBusy() and returns an ordered list of candidate
// slots, earliest first.
//
// Algorithm:
//   1. Flatten all busy intervals from all users into one list.
//   2. Walk the search window in `slotIntervalMinutes` steps.
//   3. For each candidate [start, end]:
//        a. Check it falls within workday hours.
//        b. Check it doesn't overlap ANY busy interval from ANY user.
//   4. Return up to `maxSlots` matching candidates.

/**
 * @param {Array<{email: string, busySlots: Array<{start: Date, end: Date}>}>} busyData
 *   Normalised output from calendarReader.getFreeBusy().
 *
 * @param {Date}   windowStart           Start of the search window (JS Date, UTC)
 * @param {Date}   windowEnd             End of the search window   (JS Date, UTC)
 * @param {number} durationMinutes       Meeting length in minutes (15 | 30 | 45 | 60)
 *
 * @param {object} [options]
 * @param {number}  [options.workdayStartHour=9]      Earliest allowed start (local hour, 0–23)
 * @param {number}  [options.workdayEndHour=17]        Latest allowed end     (local hour, 0–23)
 * @param {number}  [options.slotIntervalMinutes=30]  Step size when scanning for slots
 * @param {number}  [options.maxSlots=3]              Max suggestions to return
 * @param {boolean} [options.weekdaysOnly=true]       Skip Saturday and Sunday slots
 * @param {string}  [options.timezoneId='UTC']        IANA timezone for workday + weekday checks
 *
 * @returns {Array<{start: Date, end: Date}>}
 *   Candidate slots ordered earliest-first. May be empty if nothing fits.
 */
function findSlots(busyData, windowStart, windowEnd, durationMinutes, options = {}) {
  const {
    workdayStartHour    = 9,
    workdayEndHour      = 17,
    slotIntervalMinutes = 30,
    maxSlots            = 3,
    weekdaysOnly        = true,
    timezoneId          = 'UTC',
  } = options;

  // Flatten every user's busy intervals into one shared list.
  // A slot is only offered if it's free for everyone.
  const allBusy = (busyData ?? []).flatMap((u) => u.busySlots ?? []);

  const durationMs = durationMinutes * 60 * 1000;
  const intervalMs = slotIntervalMinutes * 60 * 1000;

  const results = [];
  let cursor    = new Date(windowStart);

  while (cursor < windowEnd && results.length < maxSlots) {
    const slotStart = new Date(cursor);
    const slotEnd   = new Date(cursor.getTime() + durationMs);

    // The slot must fit entirely within the search window
    if (slotEnd > windowEnd) break;

    if (
      (!weekdaysOnly || isWeekday(slotStart, timezoneId)) &&
      isWithinWorkday(slotStart, slotEnd, workdayStartHour, workdayEndHour, timezoneId) &&
      !overlapsAny(slotStart, slotEnd, allBusy)
    ) {
      results.push({ start: slotStart, end: slotEnd });
    }

    cursor = new Date(cursor.getTime() + intervalMs);
  }

  return results;
}

// ── Helpers (exported for unit testing) ──────────────────────────────────────

/**
 * Returns true if [slotStart, slotEnd) falls entirely within the workday,
 * evaluated in the given IANA timezone (defaults to 'UTC').
 *
 * The `endH >= startH` guard rejects overnight slots: a 23:30→00:00 slot has
 * endH=0.0 which is ≤17 but also < startH, so it would be a false positive
 * without this check.
 */
function isWithinWorkday(slotStart, slotEnd, workdayStartHour, workdayEndHour, timezoneId = 'UTC') {
  const startH = getLocalDecimalHour(slotStart, timezoneId);
  const endH   = getLocalDecimalHour(slotEnd,   timezoneId);
  return startH >= workdayStartHour && endH <= workdayEndHour && endH >= startH;
}

/**
 * Returns the time-of-day as a decimal hour (e.g. 9.5 = 9:30 AM) in the
 * given IANA timezone. Uses hourCycle h23 so midnight = 0, not 24.
 */
function getLocalDecimalHour(date, timezoneId = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:  timezoneId,
    hour:      'numeric',
    minute:    '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const h = parseInt(parts.find((p) => p.type === 'hour').value,   10);
  const m = parseInt(parts.find((p) => p.type === 'minute').value, 10);
  return h + m / 60;
}

/**
 * Returns true if the date falls on a Monday–Friday in the given timezone.
 * Defaults to 'UTC' so existing tests (which use UTC-based dates) are unaffected.
 */
function isWeekday(date, timezoneId = 'UTC') {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezoneId,
    weekday:  'short',
  }).format(date); // "Mon" | "Tue" | … | "Sat" | "Sun"
  return weekday !== 'Sat' && weekday !== 'Sun';
}

/**
 * Returns true if [slotStart, slotEnd) overlaps ANY interval in busySlots.
 * Standard overlap test: A overlaps B iff A.start < B.end && B.start < A.end
 */
function overlapsAny(slotStart, slotEnd, busySlots) {
  return busySlots.some((b) => slotStart < b.end && b.start < slotEnd);
}

// ── Prime-time preferred slot finder ─────────────────────────────────────────

/**
 * Finds up to `maxCount` available slots, preferring those whose start time
 * falls in the "prime" window (11 AM–3 PM local time) before falling back to
 * the full 9 AM–5 PM business-hours window.
 *
 * A minimum gap (in minutes) between the START times of chosen slots is
 * enforced so suggestions aren't clustered back-to-back.
 *
 * Algorithm:
 *   Pass 1 — sort prime slots to the front, then run a greedy pick with the
 *             gap constraint. If this fills `maxCount`, we're done.
 *   Pass 2 — if Pass 1 fell short (prime slots too sparse to satisfy the gap),
 *             retry with strict chronological order, which maximises the number
 *             of slots returned even if some are outside prime time.
 *
 * @param {Array}  busyData        Output from calendarReader.getFreeBusy()
 * @param {Date}   windowStart     Start of search window
 * @param {Date}   windowEnd       End of search window
 * @param {number} durationMinutes Meeting length in minutes
 * @param {number} maxCount        How many slots to return
 * @param {string} timezoneId      IANA timezone for prime-time classification
 * @param {number} minGapMinutes   Minimum gap between slot start times (default 0)
 * @returns {Array<{start: Date, end: Date}>}  Chronologically ordered
 */
function findSlotsWithPrimePreference(
  busyData, windowStart, windowEnd, durationMinutes,
  maxCount, timezoneId = 'UTC', minGapMinutes = 0,
) {
  // Gather every available slot in the full 9–17 business-hours window
  const allAvailable = findSlots(busyData, windowStart, windowEnd, durationMinutes, {
    workdayStartHour:    9,
    workdayEndHour:      17,
    maxSlots:            200,   // high cap — we'll filter below
    weekdaysOnly:        true,
    timezoneId,
  });

  if (allAvailable.length === 0) return [];

  const gapMs = minGapMinutes * 60 * 1000;

  // A slot is "prime" if its entire duration fits within 11 AM–3 PM local time
  function isPrime(slot) {
    const startH = getLocalDecimalHour(slot.start, timezoneId);
    const endH   = getLocalDecimalHour(slot.end,   timezoneId);
    return startH >= 11 && endH <= 15;
  }

  // Greedy pick — walks the given list in order, enforcing the gap
  function greedyPick(slots) {
    const picks  = [];
    let minNext  = null;
    for (const slot of slots) {
      if (picks.length >= maxCount) break;
      if (minNext && slot.start < minNext) continue;
      picks.push(slot);
      if (gapMs > 0) minNext = new Date(slot.start.getTime() + gapMs);
    }
    // Always return in chronological order for display
    return picks.sort((a, b) => a.start - b.start);
  }

  // Pass 1: prime slots first, then the rest (time-ordered within each group)
  const primePriority = [
    ...allAvailable.filter(isPrime),
    ...allAvailable.filter((s) => !isPrime(s)),
  ];
  const primePicks = greedyPick(primePriority);
  if (primePicks.length >= maxCount) return primePicks;

  // Pass 2: pure chronological — always finds the maximum possible slots
  return greedyPick(allAvailable);
}

module.exports = {
  findSlots,
  findSlotsWithPrimePreference,
  isWithinWorkday,
  overlapsAny,
  isWeekday,
  getLocalDecimalHour,
};
