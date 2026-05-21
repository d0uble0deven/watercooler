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
 * @param {number} [options.workdayStartHour=9]      Earliest allowed start (UTC hour, 0–23)
 * @param {number} [options.workdayEndHour=17]        Latest allowed end     (UTC hour, 0–23)
 * @param {number} [options.slotIntervalMinutes=30]  Step size when scanning for slots
 * @param {number} [options.maxSlots=3]              Max suggestions to return
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
      isWithinWorkday(slotStart, slotEnd, workdayStartHour, workdayEndHour) &&
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
 * Returns true if [slotStart, slotEnd) falls entirely within the workday.
 * Uses UTC hours so tests are timezone-independent.
 *
 * The `endH >= startH` guard rejects overnight slots: a 23:30→00:00 slot has
 * endH=0.0 which is ≤17 but also < startH, so it would be a false positive
 * without this check.
 */
function isWithinWorkday(slotStart, slotEnd, workdayStartHour, workdayEndHour) {
  // Express as decimal hours for simpler boundary comparison (e.g. 9.5 = 9:30)
  const startH = slotStart.getUTCHours() + slotStart.getUTCMinutes() / 60;
  const endH   = slotEnd.getUTCHours()   + slotEnd.getUTCMinutes()   / 60;
  return startH >= workdayStartHour && endH <= workdayEndHour && endH >= startH;
}

/**
 * Returns true if [slotStart, slotEnd) overlaps ANY interval in busySlots.
 * Standard overlap test: A overlaps B iff A.start < B.end && B.start < A.end
 */
function overlapsAny(slotStart, slotEnd, busySlots) {
  return busySlots.some((b) => slotStart < b.end && b.start < slotEnd);
}

module.exports = { findSlots, isWithinWorkday, overlapsAny };
