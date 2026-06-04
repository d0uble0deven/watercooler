'use strict';

// Handles clicks on the "🔄 Reschedule" button in the booking confirmation message.
//
// Flow:
//   1. Parse matchId from the button value.
//   2. Guard: bail if a booking is in-flight ('pending') or already rescheduling.
//   3. resetBooking() — copies calendar_event_id → previous_event_id, clears
//      booking fields. The old MS365 event is NOT deleted yet; it survives until
//      the user picks a new slot (bookSlot deletes it then via previous_event_id).
//   4. Update the confirmation message to remove the now-stale Reschedule button.
//   5. Re-run suggestMeetingTimes to post fresh slot buttons to the same DM.

const { getMatch, getMatchUsers, resetBooking, getSettings } = require('../../lib/rounds');
const { suggestMeetingTimes } = require('../../integrations/calendarScheduler');

async function handleReschedule({ action, ack, body, client }) {
  await ack();

  const matchId = parseInt(action.value, 10);
  if (isNaN(matchId)) {
    console.error('[reschedule] Invalid matchId in button value:', action.value);
    return;
  }

  const channelId = body.channel.id;
  const messageTs = body.message.ts;

  const match = getMatch(matchId);
  if (!match) {
    console.error('[reschedule] Match not found:', matchId);
    return;
  }

  // A booking is mid-flight — claimBooking set 'pending' but hasn't finished yet
  if (match.calendar_event_id === 'pending') {
    await safeUpdate(client, channelId, messageTs,
      '⏳ A booking is just being confirmed — please wait a moment, then try again.');
    return;
  }

  // Already in reschedule state: event ID was cleared but new slot not yet chosen
  if (!match.calendar_event_id && match.previous_event_id) {
    await safeUpdate(client, channelId, messageTs,
      '⏳ New time options were already posted — scroll up in this chat to pick a slot.');
    return;
  }

  // ── Initiate reschedule ────────────────────────────────────────────────────
  resetBooking(matchId);
  console.log(`[reschedule] Match ${matchId} reset for rescheduling.`);

  await safeUpdate(client, channelId, messageTs, '🔄 *Rescheduling…* New time options are being prepared.');

  // Re-run suggestion flow — force calendar_enabled so it runs regardless of
  // the global setting (the user already had a booked meeting, Azure is working)
  const users    = getMatchUsers(matchId);
  const settings = { ...getSettings(), calendar_enabled: true };

  await suggestMeetingTimes(client, channelId, matchId, users, settings);
}

async function safeUpdate(client, channelId, ts, text) {
  try {
    await client.chat.update({ channel: channelId, ts, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
  } catch (err) {
    console.warn('[reschedule] Could not update message:', err.message);
  }
}

module.exports = { handleReschedule };
