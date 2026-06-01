'use strict';

// Post-meeting completion check.
//
// Called on every scheduler tick. Finds matches whose meeting time has passed
// (or whose fallback window has expired) and posts the post-meeting message
// with feedback buttons into the group DM.
//
// Two tracks:
//   Track A — booked via Slack buttons: fires when meeting_end_at < now
//   Track B — user made own invite (no meeting_end_at): fires when the round's
//             completed_at + completion_fallback_days business days < now
//
// The completion_message_sent flag prevents the message from ever being
// sent twice to the same match.

const { getDb }                       = require('../db/connection');
const { markCompletionMessageSent }    = require('../lib/rounds');

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Run on every scheduler tick. Finds matches due for a completion message
 * and posts the post-meeting feedback prompt into their group DM.
 *
 * @param {object} client    Bolt Web API client (app.client)
 * @param {object} settings  Settings row from the DB
 */
async function runCompletionCheck(client, settings) {
  const fallbackDays = settings.completion_fallback_days ?? 12;
  const matches      = getMatchesDueForCompletion(fallbackDays);

  if (matches.length === 0) return;

  console.log(`[meetingCompleter] ${matches.length} match(es) due for completion message`);

  for (const match of matches) {
    try {
      const nextRoundDate = calculateNextRoundDate(settings);
      const tz            = settings.calendar_timezone ?? 'America/New_York';
      const hasBooking    = !!match.meeting_end_at;
      const blocks        = buildCompletionMessage(match.id, nextRoundDate, tz, hasBooking);

      await client.chat.postMessage({
        channel: match.slack_dm_channel_id,
        text:    '✅ This intro has been marked as completed.',
        blocks,
      });

      markCompletionMessageSent(match.id);
      console.log(`[meetingCompleter] Completion message sent for match ${match.id}`);
    } catch (err) {
      console.error(`[meetingCompleter] Failed for match ${match.id}:`, err.message);
    }
  }
}

// ── DB query ──────────────────────────────────────────────────────────────────

/**
 * Returns all matches that are due to receive a completion message.
 *
 * Track A (booked via Slack): meeting_end_at is in the past.
 * Track B (no Slack booking): round completed more than `fallbackBusinessDays`
 *   business days ago.
 *
 * Excludes matches that:
 *   - Already had the completion message sent
 *   - Have no DM channel to post into
 *   - Belong to a round that isn't 'completed'
 *
 * @param {number} fallbackBusinessDays
 * @returns {object[]}  Match rows
 */
function getMatchesDueForCompletion(fallbackBusinessDays) {
  const now           = new Date().toISOString();
  const fallbackCutoff = subtractBusinessDays(new Date(), fallbackBusinessDays).toISOString();

  return getDb().prepare(`
    SELECT m.*
    FROM   matches m
    JOIN   rounds  r ON r.id = m.round_id
    WHERE  m.completion_message_sent = 0
      AND  m.slack_dm_channel_id     IS NOT NULL
      AND  r.status                  = 'completed'
      AND  (
        -- Track A: meeting was booked via Slack and end time has passed
        (m.meeting_end_at IS NOT NULL AND m.meeting_end_at < ?)
        OR
        -- Track B: no Slack booking, fallback window has elapsed
        (m.meeting_end_at IS NULL AND r.completed_at < ?)
      )
  `).all(now, fallbackCutoff);
}

// ── Message builder ───────────────────────────────────────────────────────────

/**
 * Builds the Block Kit blocks for the post-meeting completion message.
 *
 * @param {number}  matchId        DB match ID (encoded in button values)
 * @param {Date}    nextRoundDate  When the next round is scheduled
 * @param {string}  timezoneId     IANA timezone for date display
 * @param {boolean} hasBooking     true = meeting was booked via Slack buttons
 * @returns {object[]}  Slack blocks array
 */
function buildCompletionMessage(matchId, nextRoundDate, timezoneId = 'America/New_York', hasBooking = false) {
  const dateLabel = formatRoundDate(nextRoundDate, timezoneId);

  const introText = hasBooking
    ? `✅ Since the scheduled meeting time has passed, this meeting has been marked as completed. The next round of intros goes out on *${dateLabel}*.`
    : `✅ Your matching window has passed, so this intro has been marked as completed. The next round of intros goes out on *${dateLabel}*.`;

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: introText },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*How was your Watercooler intro?*' },
    },
    {
      type:     'actions',
      elements: [
        {
          type:      'button',
          text:      { type: 'plain_text', text: '👍 It was good!', emoji: true },
          value:     String(matchId),
          action_id: 'watercooler_meeting_good',
          style:     'primary',
        },
        {
          type:      'button',
          text:      { type: 'plain_text', text: '👎 Meh', emoji: true },
          value:     String(matchId),
          action_id: 'watercooler_meeting_meh',
        },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Too Busy?*' },
    },
    {
      type:     'actions',
      elements: [
        {
          type:      'button',
          text:      { type: 'plain_text', text: '🤗 Snooze intros', emoji: true },
          value:     String(matchId),
          action_id: 'watercooler_meeting_snooze',
        },
      ],
    },
  ];
}

// ── Next round date ───────────────────────────────────────────────────────────

/**
 * Computes the next date/time the scheduler would fire a round, based on
 * intro_day + intro_time in settings. Used for the "next round goes out on…"
 * line in the completion message.
 *
 * Does NOT account for the cadence guard — it just finds the next calendar
 * occurrence of the scheduled day+time.
 *
 * @param {object} settings  App settings row
 * @returns {Date}
 */
function calculateNextRoundDate(settings) {
  const dayNum          = parseDayToNumber(settings.intro_day);
  const { hour, minute } = parseIntroTime(settings.intro_time);

  const now    = new Date();
  const result = new Date(now);

  // Set to the target hour/minute on today's date (local time)
  result.setHours(hour, minute, 0, 0);

  // Days until the next occurrence of intro_day
  const daysUntilNext = (dayNum - now.getDay() + 7) % 7;

  if (daysUntilNext === 0 && result <= now) {
    // Same weekday but the time has already passed — advance one full week
    result.setDate(result.getDate() + 7);
  } else {
    result.setDate(result.getDate() + daysUntilNext);
  }

  return result;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/**
 * Formats a Date as a human-readable round date, e.g. "Monday, Jun 16".
 */
function formatRoundDate(date, timezoneId = 'America/New_York') {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezoneId,
    weekday:  'long',
    month:    'short',
    day:      'numeric',
  }).format(date);
}

// ── Day / time helpers (local copies — keeps this module self-contained) ──────

const DAY_NAME_TO_NUM = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

function parseDayToNumber(introDay) {
  if (typeof introDay === 'number') return introDay % 7;
  const n = parseInt(introDay, 10);
  if (!isNaN(n)) return n % 7;
  return DAY_NAME_TO_NUM[(introDay || 'monday').toLowerCase()] ?? 1;
}

function parseIntroTime(introTime) {
  const parts  = (introTime || '09:00').split(':').map(Number);
  const hour   = parts[0];
  const minute = parts[1];
  return {
    hour:   (!isNaN(hour)   && hour   >= 0 && hour   <= 23) ? hour   : 9,
    minute: (!isNaN(minute) && minute >= 0 && minute <= 59) ? minute : 0,
  };
}

/**
 * Subtracts `n` business days from `date` (skipping Saturday + Sunday).
 * Used to compute the fallback cutoff: a round whose completed_at is before
 * this date has exceeded the fallback window.
 */
function subtractBusinessDays(date, n) {
  const d = new Date(date);
  let subtracted = 0;
  while (subtracted < n) {
    d.setDate(d.getDate() - 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) subtracted++;
  }
  return d;
}

module.exports = {
  runCompletionCheck,
  getMatchesDueForCompletion,
  buildCompletionMessage,
  calculateNextRoundDate,
  subtractBusinessDays,
  formatRoundDate,
};
