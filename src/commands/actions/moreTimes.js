'use strict';

// "🗓️ More times" — the button under the 3 starter suggestions.
//
// Opens the same private full list as Reschedule (every open half-hour until
// the round ends, visible only to whoever clicked) but NEVER resets a booking.
// Picking a time from it books through the normal booking handler, which
// posts the confirmation publicly — that's when the partner finds out.
//
//   • not booked yet (incl. mid-reschedule) → post the private list
//   • already booked → say so privately and point to Reschedule
//   • a booking is in flight ('pending')    → ask them to wait a moment
//
// Once any slot is booked, the starter message (and this button) is replaced,
// so "already booked" is mostly a stale-client or double-click edge case.

const config = require('../../config');
const { getMatch, getSettings } = require('../../lib/rounds');
const { formatSlotLabel } = require('../../integrations/calendarScheduler');
const { postPrivateTimeOptions, safeEphemeral } = require('./reschedule');

/**
 * Bolt action handler — registered in app.js for action_id 'watercooler_more_times'.
 * Button value: the match ID.
 */
async function handleMoreTimes({ action, ack, body, client }) {
  await ack();

  const matchId     = parseInt(action?.value, 10);
  const channelId   = body?.channel?.id;
  const requesterId = body?.user?.id;
  if (isNaN(matchId) || !channelId || !requesterId) {
    console.error('[moreTimes] Bad payload — value:', action?.value);
    return;
  }

  const match = getMatch(matchId);
  if (!match) {
    console.error('[moreTimes] Match not found:', matchId);
    return;
  }

  if (match.calendar_event_id === 'pending') {
    await safeEphemeral(client, channelId, requesterId,
      '⏳ A booking is just being confirmed — please wait a moment, then try again.');
    return;
  }

  if (match.calendar_event_id) {
    const tz = getSettings()?.calendar_timezone || config.calendarTimezone;
    const when = match.meeting_start_at && match.meeting_end_at
      ? ` for *${formatSlotLabel({ start: new Date(match.meeting_start_at), end: new Date(match.meeting_end_at) }, tz)}*`
      : '';
    await safeEphemeral(client, channelId, requesterId,
      `✅ This meeting is already booked${when}. ` +
      'To change it, click 🔄 *Reschedule* on the confirmation or run `/watercooler reschedule`.');
    return;
  }

  console.log(`[moreTimes] Posting the private time list for match ${matchId} to ${requesterId}.`);
  await postPrivateTimeOptions(client, match, requesterId);
}

module.exports = { handleMoreTimes };
