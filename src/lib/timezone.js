'use strict';

// Small timezone helpers built on Intl (no dependencies). All DST-aware.
// Used by PTO detection (all-day events), the round-end calculation and the
// private full list of times.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * How far `timezoneId`'s wall clock is ahead of UTC at `date`, in ms
 * (negative in the US: -5h for Eastern in winter).
 */
function utcOffsetMs(date, timezoneId) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezoneId, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const wallClockAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  return wallClockAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of `hour:minute` on `dateKey` ("YYYY-MM-DD") in `timezoneId`.
 * e.g. zonedTime('2026-11-23', 0, 0, 'America/New_York') → 2026-11-23T05:00Z
 */
function zonedTime(dateKey, hour, minute, timezoneId) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const naive = new Date(`${dateKey}T${hh}:${mm}:00Z`);
  // Two passes: the second corrects for a DST change between the two instants.
  let guess = naive.getTime() - utcOffsetMs(naive, timezoneId);
  guess = naive.getTime() - utcOffsetMs(new Date(guess), timezoneId);
  return new Date(guess);
}

/** The calendar date of `date` in `timezoneId`, as "YYYY-MM-DD". */
function localDateKey(date, timezoneId) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezoneId, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/** Day of week of `date` in `timezoneId`: 0 = Sunday … 6 = Saturday. */
function localWeekday(date, timezoneId) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezoneId, weekday: 'long' }).format(date);
  return WEEKDAYS.indexOf(name.toLowerCase());
}

/** "YYYY-MM-DD" ± n days (pure date arithmetic, no timezone involved). */
function addDaysToKey(dateKey, n) {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The process's own timezone (the VM runs in America/New_York). */
function processTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

module.exports = { utcOffsetMs, zonedTime, localDateKey, localWeekday, addDaysToKey, processTimezone, WEEKDAYS };
