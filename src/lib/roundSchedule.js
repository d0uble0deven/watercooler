'use strict';

// When does the next round go out?
//
// The scheduler (scheduler/index.js) ticks every minute in the server's own
// timezone and starts a round at intro_day + intro_time once shouldRunNow()
// agrees enough days have passed for the cadence (triweekly → 20+ days).
//
// This module answers "when will that next happen?" by asking shouldRunNow
// itself about each upcoming intro_day/intro_time — so these dates can never
// drift from the scheduler's real behaviour. Used for:
//   • the end of a match's round — the private full list of times stops there
//   • "the next round of intros goes out on …" in wrap-up messages
//
// Like the scheduler, this assumes SCHEDULING_ENABLED is on; admins can still
// start a round by hand at any time.

const { shouldRunNow, parseDayToNumber, parseTime } = require('../scheduler');
const { zonedTime, localDateKey, localWeekday, addDaysToKey, processTimezone } = require('./timezone');

// Monthly needs 27+ days, so a matching intro day always exists within ~5 weeks.
const MAX_DAYS_AHEAD = 70;

/**
 * The first intro_day at intro_time strictly after `after` at which the
 * scheduler would start a round, given the last round started at
 * `lastRoundStartedAt`.
 *
 * @param {object}      settings            intro_day, intro_time, cadence
 * @param {string|null} lastRoundStartedAt  rounds.started_at ("YYYY-MM-DD HH:MM:SS", UTC), or null
 * @param {Date}        [after=new Date()]
 * @param {string}      [timezoneId]        Timezone the scheduler ticks in (default: this process's)
 * @returns {Date|null}  null only if settings are unusable
 */
function nextRoundTime(settings, lastRoundStartedAt, after = new Date(), timezoneId = processTimezone()) {
  const dayNum = parseDayToNumber(settings?.intro_day);
  const { hour, minute } = parseTime(settings?.intro_time);
  const firstDay = localDateKey(after, timezoneId);

  for (let i = 0; i <= MAX_DAYS_AHEAD; i++) {
    const candidate = zonedTime(addDaysToKey(firstDay, i), hour, minute, timezoneId);
    if (candidate <= after) continue;
    if (localWeekday(candidate, timezoneId) !== dayNum) continue;
    if (shouldRunNow(settings?.cadence, lastRoundStartedAt, candidate)) return candidate;
  }
  return null;
}

/**
 * When a round ends — the moment the next one would start.
 *
 * @param {object} round     rounds row (needs started_at)
 * @param {object} settings
 * @param {string} [timezoneId]
 * @returns {Date|null}  null if the round has no start time
 */
function getRoundEndDate(round, settings, timezoneId = processTimezone()) {
  if (!round?.started_at) return null;
  return nextRoundTime(settings, round.started_at, parseDbUtc(round.started_at), timezoneId);
}

/** rounds.started_at is SQLite "YYYY-MM-DD HH:MM:SS" in UTC (no zone marker). */
function parseDbUtc(ts) {
  return /[zZ]$|[+-]\d\d:?\d\d$/.test(ts) ? new Date(ts) : new Date(`${ts.replace(' ', 'T')}Z`);
}

module.exports = { nextRoundTime, getRoundEndDate };
