'use strict';

// Handles clicks on the time-slot booking buttons posted in match DMs.
//
// Button value format (set by calendarScheduler.buildSuggestionsMessage):
//   "<ISO start>|<ISO end>|<matchId>"
//   e.g. "2025-06-09T09:00:00.000Z|2025-06-09T09:30:00.000Z|42"
//
// Flow:
//   1. Parse slot times and matchId from the button value.
//   2. Guard: if already booked, show existing booking instead of creating a duplicate.
//   3. Fetch match participants and their emails from DB.
//   4. Call Graph API to create calendar event + Teams link.
//   5. Persist booking to DB.
//   6. Update the original Slack message (replace buttons with confirmation).

const config           = require('../../config');
const { getGraphClient } = require('../../integrations/msGraph');
const { bookMeeting, buildConfirmationMessage, buildAlreadyBookedMessage } = require('../../integrations/calendarBooker');
const { getMatch, getMatchUsers, saveBooking, saveMeetingTimes, getSettings } = require('../../lib/rounds');

/**
 * Bolt action handler — registered in app.js for action IDs matching
 * /^watercooler_book_slot_\d+$/
 */
async function handleBookSlot({ action, ack, body, client }) {
  // Always ack within 3 s to prevent Slack's "operation timed out" error
  await ack();

  // ── Parse button value ─────────────────────────────────────────────────────
  const parts = (action.value || '').split('|');
  if (parts.length !== 3) {
    console.error('[bookSlot] Malformed button value:', action.value);
    return;
  }

  const [startIso, endIso, matchIdStr] = parts;
  const matchId   = parseInt(matchIdStr, 10);
  const slotStart = new Date(startIso);
  const slotEnd   = new Date(endIso);

  if (isNaN(matchId) || isNaN(slotStart) || isNaN(slotEnd)) {
    console.error('[bookSlot] Could not parse button value:', action.value);
    return;
  }

  const channelId = body.channel.id;
  const messageTs = body.message.ts;

  // ── Guard: already booked? ─────────────────────────────────────────────────
  const match = getMatch(matchId);
  if (match?.calendar_event_id) {
    // Someone else already booked — show the existing confirmation quietly
    try {
      await client.chat.update({
        channel: channelId,
        ts:      messageTs,
        text:    '✅ This meeting has already been booked!',
        blocks:  buildAlreadyBookedMessage(match.teams_link),
      });
    } catch (err) {
      console.warn('[bookSlot] Could not update already-booked message:', err.message);
    }
    return;
  }

  // ── Fetch participants ─────────────────────────────────────────────────────
  const users  = getMatchUsers(matchId);
  const emails = users.map((u) => u.slack_email).filter(Boolean);

  if (emails.length < users.length || users.length === 0) {
    await safePostMessage(client, channelId,
      '⚠️ Couldn\'t book the meeting — some participants don\'t have email addresses on file.\n' +
      '_Make sure the `users:read.email` Slack scope is enabled and everyone has joined Watercooler._'
    );
    return;
  }

  // ── Azure credentials check ────────────────────────────────────────────────
  const graphClient = getGraphClient();
  if (!graphClient) {
    await safePostMessage(client, channelId,
      '⚠️ Calendar integration is not configured — Azure credentials are missing from `.env`.'
    );
    return;
  }

  // ── Create the meeting ─────────────────────────────────────────────────────
  let booking;
  try {
    booking = await bookMeeting(graphClient, users, slotStart, slotEnd);
  } catch (err) {
    console.error('[bookSlot] Graph API booking failed:', err.message);
    await safePostMessage(client, channelId,
      `⚠️ Couldn't create the calendar event: _${err.message}_\n` +
      'Please coordinate a time directly in this chat.'
    );
    return;
  }

  // ── Persist to DB ──────────────────────────────────────────────────────────
  saveBooking(matchId, {
    calendarEventId: booking.eventId,
    teamsLink:       booking.teamsLink,
  });
  saveMeetingTimes(matchId, slotStart, slotEnd);

  console.log(`[bookSlot] Match ${matchId} booked → event ${booking.eventId}`);

  // ── Update Slack message (replace buttons with confirmation) ────────────────
  const settings = getSettings();
  const timezone = config.calendarTimezone;

  try {
    await client.chat.update({
      channel: channelId,
      ts:      messageTs,
      text:    '✅ Meeting booked!',
      blocks:  buildConfirmationMessage(booking, users, timezone),
    });
  } catch (err) {
    // Non-fatal — the booking was made, we just couldn't update the message
    console.warn('[bookSlot] Could not update Slack message after booking:', err.message);
    await safePostMessage(client, channelId,
      '✅ Meeting booked! Check your calendar for the invite.'
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function safePostMessage(client, channelId, text) {
  try {
    await client.chat.postMessage({ channel: channelId, text });
  } catch (err) {
    console.error('[bookSlot] Failed to post error message:', err.message);
  }
}

module.exports = { handleBookSlot };
