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
//   6. Show the confirmation (see below).
//
// TWO SOURCES OF SLOT BUTTONS — the confirmation path differs:
//   • Public suggestion message (initial round intro): chat.update() the
//     original message in place, replacing buttons with the confirmation.
//   • EPHEMERAL suggestion (the private reschedule flow): the clicked message
//     is visible only to the requester and has no updatable ts, so instead we
//     post the confirmation PUBLICLY — this is the moment the match partner
//     learns about the new time — and then clear the requester's private
//     options via response_url.
//
// Errors during a private flow stay private, so a failed reschedule attempt
// never leaks into the shared DM.

const config           = require('../../config');
const { getGraphClient } = require('../../integrations/msGraph');
const { bookMeeting, buildConfirmationMessage, buildAlreadyBookedMessage } = require('../../integrations/calendarBooker');
const { getMatch, getMatchUsers, saveBooking, claimBooking, releaseBookingClaim, saveMeetingTimes, getSettings, clearPreviousEvent } = require('../../lib/rounds');
const { assignFunFact } = require('../../lib/funFacts');

/**
 * Bolt action handler — registered in app.js for action IDs matching
 * /^watercooler_book_slot_\d+$/
 */
async function handleBookSlot({ action, ack, body, client, respond }) {
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
  // Ephemeral messages carry no updatable ts — guard every access accordingly.
  const isEphemeral = body.container?.is_ephemeral === true;
  const messageTs   = body.message?.ts;

  // ── Claim the booking slot (TOCTOU guard) ─────────────────────────────────
  // Atomically writes 'pending' to calendar_event_id WHERE it is NULL.
  // If another request already claimed or booked this match, bail out now —
  // before making any Graph API call that would create a duplicate event.
  if (!claimBooking(matchId)) {
    const match  = getMatch(matchId);
    const blocks = buildAlreadyBookedMessage(match?.teams_link ?? null);
    const text   = '✅ This meeting has already been booked!';

    if (isEphemeral) {
      // Replace only the requester's private options — the shared DM already
      // has (or is about to get) the real confirmation from whoever won.
      await safeRespond(respond, { replace_original: true, text, blocks });
    } else {
      try {
        await client.chat.update({ channel: channelId, ts: messageTs, text, blocks });
      } catch (err) {
        console.warn('[bookSlot] Could not update already-booked message:', err.message);
      }
    }
    return;
  }

  // ── Fetch participants ─────────────────────────────────────────────────────
  const users  = getMatchUsers(matchId);
  const emails = users.map((u) => u.slack_email).filter(Boolean);

  if (emails.length < users.length || users.length === 0) {
    releaseBookingClaim(matchId);
    await notifyRequester({ isEphemeral, respond, client, channelId },
      '⚠️ Couldn\'t book the meeting — some participants don\'t have email addresses on file.\n' +
      '_Make sure the `users:read.email` Slack scope is enabled and everyone has joined Watercooler._'
    );
    return;
  }

  // ── Azure credentials check ────────────────────────────────────────────────
  const graphClient = getGraphClient();
  if (!graphClient) {
    releaseBookingClaim(matchId);
    await notifyRequester({ isEphemeral, respond, client, channelId },
      '⚠️ Calendar integration is not configured — Azure credentials are missing from `.env`.'
    );
    return;
  }

  // ── Create the meeting ─────────────────────────────────────────────────────
  // Draw a conversation-starter fact for the invite, avoiding repeats in this round.
  const funFact = assignFunFact(matchId, getMatch(matchId)?.round_id);

  let booking;
  try {
    booking = await bookMeeting(graphClient, users, slotStart, slotEnd, funFact);
  } catch (err) {
    releaseBookingClaim(matchId); // let the user retry by clicking again
    console.error('[bookSlot] Graph API booking failed:', err.message);
    await notifyRequester({ isEphemeral, respond, client, channelId },
      `⚠️ Couldn't create the calendar event: _${err.message}_\n` +
      'Please coordinate a time directly in this chat.'
    );
    return;
  }

  // ── Persist to DB ──────────────────────────────────────────────────────────
  // Re-fetch to get previous_event_id before saveBooking overwrites the row
  const matchBeforeSave = getMatch(matchId);
  const previousEventId = matchBeforeSave?.previous_event_id ?? null;

  saveBooking(matchId, {
    calendarEventId: booking.eventId,
    teamsLink:       booking.teamsLink,
  });
  saveMeetingTimes(matchId, slotStart, slotEnd);

  console.log(`[bookSlot] Match ${matchId} booked → event ${booking.eventId}`);

  // ── Delete old event if this was a reschedule ──────────────────────────────
  if (previousEventId) {
    clearPreviousEvent(matchId);
    try {
      const organizer = users.find((u) => u.slack_email)?.slack_email;
      if (organizer) {
        await graphClient
          .api(`/users/${encodeURIComponent(organizer)}/events/${encodeURIComponent(previousEventId)}`)
          .delete();
        console.log(`[bookSlot] Deleted old event ${previousEventId} for match ${matchId}`);
      }
    } catch (err) {
      // Non-fatal — old event may already be gone or Graph may be flaky
      console.warn(`[bookSlot] Could not delete old event for match ${matchId}:`, err.message);
    }
  }

  // ── Show the confirmation ──────────────────────────────────────────────────
  const settings = getSettings();
  const timezone = config.calendarTimezone;
  const blocks   = buildConfirmationMessage(booking, users, timezone, matchId);

  if (isEphemeral) {
    // Private reschedule flow. Post the confirmation PUBLICLY first — this is
    // the moment the match partner learns the time changed, and it's the part
    // that must not be lost. Clearing the requester's private options is
    // best-effort cleanup afterwards.
    try {
      await client.chat.postMessage({ channel: channelId, text: '✅ Meeting booked!', blocks });
    } catch (err) {
      console.error('[bookSlot] Could not post booking confirmation:', err.message);
    }
    await safeRespond(respond, {
      replace_original: true,
      text: '✅ Booked! The confirmation has been posted in this chat.',
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: '✅ *Booked!* The confirmation has been posted in this chat.' },
      }],
    });
    return;
  }

  // Public suggestion message — swap the buttons out for the confirmation.
  try {
    await client.chat.update({ channel: channelId, ts: messageTs, text: '✅ Meeting booked!', blocks });
  } catch (err) {
    // Non-fatal — the booking was made, we just couldn't update the message
    console.warn('[bookSlot] Could not update Slack message after booking:', err.message);
    await safePostMessage(client, channelId,
      '✅ Meeting booked! Check your calendar for the invite.'
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Sends a message back to whoever clicked, matching the privacy of the message
 * they clicked: ephemeral (private reschedule) stays private via response_url;
 * a public suggestion message posts to the shared DM as before.
 */
async function notifyRequester({ isEphemeral, respond, client, channelId }, text) {
  if (isEphemeral) {
    await safeRespond(respond, { replace_original: false, text });
    return;
  }
  await safePostMessage(client, channelId, text);
}

async function safeRespond(respond, payload) {
  if (typeof respond !== 'function') return;
  try {
    await respond(payload);
  } catch (err) {
    console.warn('[bookSlot] Could not respond via response_url:', err.message);
  }
}

async function safePostMessage(client, channelId, text) {
  try {
    await client.chat.postMessage({ channel: channelId, text });
  } catch (err) {
    console.error('[bookSlot] Failed to post error message:', err.message);
  }
}

module.exports = { handleBookSlot };
