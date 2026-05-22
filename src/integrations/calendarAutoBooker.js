'use strict';

// Auto-books meetings for match groups that haven't self-selected a time
// before the booking deadline.
//
// Called on every scheduler tick (once per minute). Does nothing unless:
//   • settings.calendar_enabled is true
//   • Azure credentials are present
//   • At least one match is past its deadline without a booking
//
// When a match qualifies:
//   1. Fetch participants' free/busy data from Graph.
//   2. Pick the first available slot with findSlots().
//   3. Create the calendar event + Teams link via bookMeeting().
//   4. Update the original suggestion message in-place (or post new if ts missing).
//
// "Booking deadline" uses the business-day formula from show-settings:
//   whole_days × 24h + fractional_part × 8h
//   e.g. 2.5 → 48 + 4 = 52 hours

const config               = require('../config');
const { getGraphClient }   = require('./msGraph');
const { getFreeBusy }      = require('./calendarReader');
const { bookMeeting }      = require('./calendarBooker');
const { buildSearchWindow, formatSlotLabel } = require('./calendarScheduler');
const { findSlots }        = require('../lib/slotFinder');
const { formatNameList }   = require('../slack/messaging');
const {
  getMatchUsers,
  getUnbookedMatchesPastDeadline,
  saveBooking,
} = require('../lib/rounds');

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Run on every scheduler tick. Finds unbooked matches past the deadline and
 * auto-books a meeting slot for each one.
 *
 * @param {object} client    Bolt Web API client (app.client)
 * @param {object} settings  Settings row from the DB
 */
async function runAutoBooking(client, settings) {
  if (!settings.calendar_enabled) return;

  const graphClient = getGraphClient();
  if (!graphClient) return;

  const deadlineHours = bookingDeadlineHours(settings.booking_deadline ?? 2.5);
  const matches       = getUnbookedMatchesPastDeadline(deadlineHours);

  if (matches.length === 0) return;

  console.log(`[calendarAutoBooker] ${matches.length} match(es) past deadline — auto-booking...`);

  for (const match of matches) {
    try {
      await autoBookMatch(client, graphClient, match, settings);
    } catch (err) {
      console.error(`[calendarAutoBooker] Failed to auto-book match ${match.id}:`, err.message);
    }
  }
}

// ── Core auto-booking logic ───────────────────────────────────────────────────

async function autoBookMatch(client, graphClient, match, settings) {
  const users  = getMatchUsers(match.id);
  const emails = users.map((u) => u.slack_email).filter(Boolean);

  if (users.length === 0 || emails.length < users.length) {
    console.warn(`[calendarAutoBooker] Match ${match.id}: missing email(s) — skipping.`);
    return;
  }

  // Find the next available shared slot
  const { start, end } = buildSearchWindow(new Date());
  const busyData = await getFreeBusy(graphClient, emails, start, end);
  const slots    = findSlots(busyData, start, end, settings.meeting_duration ?? 30, { maxSlots: 1 });

  if (slots.length === 0) {
    console.warn(`[calendarAutoBooker] Match ${match.id}: no free slots found.`);
    await postOrUpdate(client, match, '⏰ Booking deadline passed — no slots found.', buildNoSlotsMessage());
    return;
  }

  // Create the calendar event
  const booking = await bookMeeting(graphClient, users, slots[0].start, slots[0].end);
  saveBooking(match.id, { calendarEventId: booking.eventId, teamsLink: booking.teamsLink });
  console.log(`[calendarAutoBooker] Match ${match.id} auto-booked → event ${booking.eventId}`);

  const tz = settings.calendar_timezone ?? config.calendarTimezone;
  await postOrUpdate(
    client, match,
    '⏰ Meeting auto-booked!',
    buildAutoBookedMessage(booking, users, tz)
  );
}

/**
 * Updates the original suggestion message if its ts was stored, otherwise
 * falls back to posting a new message in the same channel.
 */
async function postOrUpdate(client, match, text, blocks) {
  if (match.calendar_suggestion_ts) {
    try {
      await client.chat.update({
        channel: match.slack_dm_channel_id,
        ts:      match.calendar_suggestion_ts,
        text,
        blocks,
      });
      return;
    } catch (err) {
      console.warn('[calendarAutoBooker] chat.update failed — falling back to postMessage:', err.message);
    }
  }
  await client.chat.postMessage({ channel: match.slack_dm_channel_id, text, blocks });
}

// ── Message builders ──────────────────────────────────────────────────────────

/**
 * Block Kit message for a successful auto-booking. Similar to the manual
 * confirmation but with an ⏰ prefix to indicate it was automatic.
 */
function buildAutoBookedMessage(booking, users, timezoneId = 'UTC') {
  const timeLabel = formatSlotLabel({ start: booking.start, end: booking.end }, timezoneId);
  const nameList  = formatNameList(users.map((u) => u.display_name));

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `⏰ *Meeting auto-booked!*\n\n📅 ${timeLabel}\n👥 ${nameList}`,
      },
    },
    ...(booking.teamsLink ? [{
      type:     'actions',
      elements: [{
        type:      'button',
        text:      { type: 'plain_text', text: '🎥 Join Teams Meeting', emoji: true },
        url:       booking.teamsLink,
        action_id: 'watercooler_join_teams',
        style:     'primary',
      }],
    }] : []),
    {
      type:     'context',
      elements: [{
        type: 'mrkdwn',
        text: '_The booking deadline passed, so Watercooler automatically selected this time. A calendar invite has been sent to everyone._',
      }],
    },
  ];
}

/**
 * Block Kit message posted when the deadline passes but no shared free slot
 * could be found. Asks participants to coordinate directly.
 */
function buildNoSlotsMessage() {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        '⏰ *Booking deadline passed.*\n' +
        'No shared free slots were found — please coordinate a time directly in this chat.',
    },
  }];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts the booking_deadline setting (fractional business days) to hours.
 * Whole days use 24h each; the fractional part uses 8h (one business day).
 *
 * Examples:
 *   2.5 → (2 × 24) + (0.5 × 8) = 52 h
 *   2.0 → (2 × 24) + (0 × 8)   = 48 h
 *   1.0 → 24 h
 */
function bookingDeadlineHours(deadline) {
  return Math.floor(deadline) * 24 + (deadline % 1) * 8;
}

module.exports = {
  runAutoBooking,
  buildAutoBookedMessage,
  buildNoSlotsMessage,
  bookingDeadlineHours,
};
