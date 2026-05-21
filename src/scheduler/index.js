'use strict';

// Watercooler Scheduler
//
// Checks every minute whether it's time to run matching.
// Controlled by SCHEDULING_ENABLED=true in .env — off by default for dev.
//
// Schedule is driven by settings.intro_day + settings.intro_time (re-read from
// DB on every tick, so admin `set` changes take effect without a restart).
//
// Cadence guard prevents double-runs:
//   weekly   → at least 6 days since last round
//   biweekly → at least 13 days
//   monthly  → at least 27 days

const config                = require('../config');
const { getSettings }       = require('../lib/rounds');
const { getParticipantCounts } = require('../lib/rounds');

// ── Day helpers ───────────────────────────────────────────────────────────────

const DAY_NAME_TO_NUM = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

/**
 * Convert intro_day to JS Date.getDay() number (0 = Sunday, 1 = Monday …).
 * Accepts: "monday" | "1" | 1
 */
function parseDayToNumber(introDay) {
  if (typeof introDay === 'number') return introDay % 7;
  const n = parseInt(introDay, 10);
  if (!isNaN(n)) return n % 7;
  return DAY_NAME_TO_NUM[(introDay || 'monday').toLowerCase()] ?? 1;
}

/**
 * Parse intro_time string ("09:00") into { hour, minute }.
 * Falls back to 09:00 on any parse failure.
 */
function parseTime(introTime) {
  const parts = (introTime || '09:00').split(':').map(Number);
  const hour   = parts[0];
  const minute = parts[1];
  return {
    hour:   (!isNaN(hour)   && hour   >= 0 && hour   <= 23) ? hour   : 9,
    minute: (!isNaN(minute) && minute >= 0 && minute <= 59) ? minute : 0,
  };
}

// ── Cadence guard ─────────────────────────────────────────────────────────────

/**
 * Returns true if enough time has passed since the last round to justify
 * running again. A ±1 day grace window tolerates server restarts or drift.
 *
 * @param {string} cadence       - 'weekly' | 'biweekly' | 'monthly'
 * @param {string|null} lastRoundDate - ISO string from the DB, or null
 */
function shouldRunNow(cadence, lastRoundDate) {
  if (!lastRoundDate) return true; // never run before — go ahead

  const daysSinceLast =
    (Date.now() - new Date(lastRoundDate).getTime()) / (1000 * 60 * 60 * 24);

  switch ((cadence || 'weekly').toLowerCase()) {
    case 'weekly':     return daysSinceLast >= 6;   // 7 days minus 1-day grace
    case 'biweekly':   return daysSinceLast >= 13;  // 14 days minus 1-day grace
    case 'triweekly':  return daysSinceLast >= 20;  // 21 days minus 1-day grace
    case 'monthly':    return daysSinceLast >= 27;  // handles 28–31 day months
    default:           return true;
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/**
 * Start the scheduler. Must be called after `await app.start()` so that
 * app.client is ready to make Slack API calls.
 *
 * @param {import('@slack/bolt').App} app - Bolt App instance
 */
function startScheduler(app) {
  if (!config.schedulingEnabled) {
    console.log('[Scheduler] Disabled — set SCHEDULING_ENABLED=true in .env to enable.');
    return;
  }

  console.log('[Scheduler] Started — checking every minute for a scheduled run.');

  const tick = async () => {
    try {
      // Re-read settings on every tick so admin changes take effect immediately.
      const settings = getSettings();
      const now      = new Date();

      const { hour, minute } = parseTime(settings.intro_time);
      const dayNum           = parseDayToNumber(settings.intro_day);

      // Does the current moment match the configured schedule?
      if (now.getDay()     !== dayNum)  return;
      if (now.getHours()   !== hour)    return;
      if (now.getMinutes() !== minute)  return;

      // Has enough time passed since the last run?
      const counts = getParticipantCounts();
      if (!shouldRunNow(settings.cadence, counts.lastRoundDate)) {
        console.log(
          `[Scheduler] Cadence check: skipping ` +
          `(cadence=${settings.cadence}, last ran: ${counts.lastRoundDate || 'never'})`
        );
        return;
      }

      console.log(
        `[Scheduler] 🚀 Triggering run — ` +
        `cadence: ${settings.cadence}, ` +
        `day: ${settings.intro_day}, ` +
        `time: ${settings.intro_time}`
      );

      // Reuse run.js exactly as the admin command does.
      // Synthetic command: user_id = 'scheduler'; respond = console.log.
      const run    = require('../commands/admin/run');
      const respond = (msg) => console.log('[Scheduler]', msg);
      await run({ user_id: 'scheduler' }, respond, app.client);

    } catch (err) {
      console.error('[Scheduler] Unexpected error during tick:', err);
    }
  };

  // Align the first tick to the top of the next whole minute so subsequent
  // ticks land reliably at :00 seconds (minimises clock drift).
  const secondsUntilNextMinute = 60 - new Date().getSeconds();
  setTimeout(() => {
    tick();                        // fire at the aligned boundary
    setInterval(tick, 60_000);    // then every 60 s
  }, secondsUntilNextMinute * 1000);
}

module.exports = { startScheduler, shouldRunNow, parseDayToNumber, parseTime };
