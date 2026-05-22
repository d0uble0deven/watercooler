'use strict';

// Orchestrates the calendar-suggestion flow for a match group:
//
//   1. Resolve each participant's email (from DB cache or Slack users.info).
//   2. Query Microsoft Graph for free/busy data over the next 5 business days.
//   3. Find up to 3 slots when everyone is free.
//   4. Post an interactive Block Kit message with booking buttons to the match DM.
//
// The `suggestMeetingTimes` entry point is called by `admin/run.js` right after
// the intro DM is sent. Every failure mode is caught and logged — a calendar
// error must never prevent the round from completing.
//
// Prerequisites (for the live path):
//   • AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET in .env
//   • CALENDAR_ENABLED=true in .env (or set via admin command)
//   • Slack app has the `users:read.email` scope (add in api.slack.com → OAuth & Permissions)

const config               = require('../config');
const { getGraphClient }   = require('./msGraph');
const { getFreeBusy }      = require('./calendarReader');
const { findSlots }        = require('../lib/slotFinder');
const { saveUserEmail }    = require('../lib/users');
const { saveSuggestionTs } = require('../lib/rounds');

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Fetches free/busy data for a match group, finds open slots, and posts a
 * Block Kit message with booking buttons to the match DM channel.
 *
 * Silently skips (logs only) when:
 *   - calendar_enabled is false in DB settings
 *   - Azure credentials are missing
 *   - Any participant's email cannot be resolved
 *   - No shared free slots are found in the search window
 *
 * @param {object}   client     Bolt Web API client
 * @param {string}   channelId  Slack DM channel ID for this match group
 * @param {number}   matchId    DB match ID (encoded in button values for Step 6)
 * @param {object[]} users      Array of user rows from the DB
 * @param {object}   settings   App settings row (calendar_enabled, meeting_duration)
 */
async function suggestMeetingTimes(client, channelId, matchId, users, settings) {
  // ── Guard: feature flags ──────────────────────────────────────────────────
  if (!settings.calendar_enabled) return;

  const graphClient = getGraphClient();
  if (!graphClient) {
    console.warn('[calendarScheduler] Azure credentials missing — skipping suggestions.');
    return;
  }

  // ── Resolve emails ────────────────────────────────────────────────────────
  const emails = await resolveEmails(client, users);
  if (emails.length < users.length) {
    const missing = users.length - emails.length;
    console.warn(`[calendarScheduler] ${missing} user(s) missing email — skipping suggestions for match ${matchId}.`);
    return;
  }

  // ── Free/busy query ───────────────────────────────────────────────────────
  const { start, end } = buildSearchWindow(new Date());
  const busyData = await getFreeBusy(graphClient, emails, start, end);

  // ── Slot finding ──────────────────────────────────────────────────────────
  const durationMinutes = settings.meeting_duration ?? 30;
  const slots = findSlots(busyData, start, end, durationMinutes, { maxSlots: 3 });

  if (slots.length === 0) {
    console.log(`[calendarScheduler] No shared free slots found for match ${matchId} — skipping suggestions.`);
    return;
  }

  // ── Post interactive message ──────────────────────────────────────────────
  const blocks = buildSuggestionsMessage(slots, matchId, config.calendarTimezone);

  try {
    const result = await client.chat.postMessage({
      channel: channelId,
      text:    '📅 Here are some times that work for your meeting!',  // fallback for notifications
      blocks,
    });
    // Store the message ts so the auto-booker can update this message in-place
    if (result?.ts) saveSuggestionTs(matchId, result.ts);
    console.log(`[calendarScheduler] Posted ${slots.length} slot suggestion(s) for match ${matchId}.`);
  } catch (err) {
    console.error(`[calendarScheduler] Failed to post suggestions for match ${matchId}:`, err.message);
  }
}

// ── Email resolution ──────────────────────────────────────────────────────────

/**
 * Returns an email address for each user.
 * Uses the cached `slack_email` column first; falls back to calling Slack's
 * `users.info` endpoint (requires the `users:read.email` OAuth scope).
 *
 * Returns only the emails that were successfully resolved — callers check
 * whether the count matches `users.length`.
 */
async function resolveEmails(client, users) {
  const emails = [];

  for (const user of users) {
    if (user.slack_email) {
      emails.push(user.slack_email);
      continue;
    }

    try {
      const result = await client.users.info({ user: user.slack_user_id });
      const email  = result?.user?.profile?.email;

      if (email) {
        saveUserEmail(user.slack_user_id, email);  // cache for future rounds
        emails.push(email);
      } else {
        console.warn(
          `[calendarScheduler] No email in Slack profile for ${user.slack_user_id}. ` +
          'Ensure the Slack app has the users:read.email OAuth scope.'
        );
      }
    } catch (err) {
      console.warn(`[calendarScheduler] users.info failed for ${user.slack_user_id}:`, err.message);
    }
  }

  return emails;
}

// ── Search window ─────────────────────────────────────────────────────────────

/**
 * Builds a search window of 5 business days starting from tomorrow.
 * Weekends are skipped so the window always spans Mon–Fri days only.
 *
 * @param  {Date} fromDate  Reference point (usually `new Date()`)
 * @returns {{ start: Date, end: Date }}
 */
function buildSearchWindow(fromDate, businessDays = 5) {
  const start = nextBusinessDay(fromDate);
  start.setUTCHours(9, 0, 0, 0);

  const end = addBusinessDays(new Date(start), businessDays);
  end.setUTCHours(17, 0, 0, 0);

  return { start, end };
}

function nextBusinessDay(date) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + 1);
  // Skip weekends
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

function addBusinessDays(date, n) {
  const d = new Date(date);
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) added++;
  }
  return d;
}

// ── Slack Block Kit message builder ──────────────────────────────────────────

/**
 * Builds a Block Kit blocks array for the suggestions message.
 * Pure function — no side effects, easy to unit test.
 *
 * @param {Array<{start: Date, end: Date}>} slots
 * @param {number} matchId
 * @param {string} timezoneId  IANA timezone for display (e.g. 'America/New_York')
 * @returns {object[]}  Slack blocks array
 */
function buildSuggestionsMessage(slots, matchId, timezoneId = 'UTC') {
  const tzAbbr = getTzAbbr(slots[0].start, timezoneId);

  const buttons = slots.map((slot, i) => ({
    type: 'button',
    text: {
      type:  'plain_text',
      text:  formatSlotLabel(slot, timezoneId),
      emoji: false,
    },
    // Value encodes all info needed to book the slot in Step 6:
    //   "<ISO start>|<ISO end>|<matchId>"
    value:     `${slot.start.toISOString()}|${slot.end.toISOString()}|${matchId}`,
    action_id: `watercooler_book_slot_${i}`,
    style:     'primary',
  }));

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '📅 *Here are some times that work for everyone!*\n' +
          'Click a slot to book it — a calendar invite and Teams meeting link will be sent to everyone.',
      },
    },
    {
      type:     'actions',
      elements: buttons,
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_All times in ${tzAbbr}. If none of these work, coordinate directly in this chat._`,
        },
      ],
    },
  ];
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/**
 * Formats a slot as a human-readable button label.
 * Example: "Mon Jun 9, 9:00 – 9:30 AM"
 *
 * Uses Intl.DateTimeFormat (Node built-in) for timezone-aware formatting.
 */
function formatSlotLabel(slot, timezoneId = 'UTC') {
  const startStr = new Intl.DateTimeFormat('en-US', {
    timeZone: timezoneId,
    weekday:  'short',
    month:    'short',
    day:      'numeric',
    hour:     'numeric',
    minute:   '2-digit',
    hour12:   true,
  }).format(slot.start);

  const endStr = new Intl.DateTimeFormat('en-US', {
    timeZone: timezoneId,
    hour:     'numeric',
    minute:   '2-digit',
    hour12:   true,
  }).format(slot.end);

  return `${startStr} – ${endStr}`;
}

/**
 * Returns the short timezone abbreviation for a given date, e.g. "EDT", "CST".
 */
function getTzAbbr(date, timezoneId) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezoneId, timeZoneName: 'short' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value ?? timezoneId;
}

module.exports = {
  suggestMeetingTimes,
  buildSearchWindow,
  buildSuggestionsMessage,
  formatSlotLabel,
  // Exported for testing
  nextBusinessDay,
  addBusinessDays,
};
