'use strict';

// Reschedule flow — reachable two ways:
//   1. Clicking the "🔄 Reschedule" button on a booking confirmation message.
//   2. Running /watercooler reschedule (src/commands/user/reschedule.js),
//      which finds the user's upcoming match and reuses this same core logic.
//
// Both call checkRescheduleEligibility() + performReschedule() below, so the
// guard conditions and the reset/re-suggest behavior only exist in one place.
//
// Flow:
//   1. Guard: bail if a booking is in-flight ('pending') or already rescheduling.
//   2. resetBooking() — copies calendar_event_id → previous_event_id, clears
//      booking fields. The old MS365 event is NOT deleted yet; it survives until
//      the user picks a new slot (bookSlot deletes it then via previous_event_id).
//   3. Re-run suggestMeetingTimes (rich mode — more slots, more spread) to post
//      fresh slot buttons to the match DM.

const { getMatch, getMatchUsers, resetBooking, getSettings } = require('../../lib/rounds');
const { suggestMeetingTimes } = require('../../integrations/calendarScheduler');

/**
 * Guard-only check — no side effects. Both entry points call this first so
 * they can show the right message (or bail) before touching anything.
 *
 * @returns {{status: 'not_found'|'pending'|'already_rescheduling'|'ok', match?: object}}
 */
function checkRescheduleEligibility(matchId) {
  const match = getMatch(matchId);
  if (!match) return { status: 'not_found' };

  // A booking is mid-flight — claimBooking set 'pending' but hasn't finished yet
  if (match.calendar_event_id === 'pending') return { status: 'pending', match };

  // Already in reschedule state: event ID was cleared but new slot not yet chosen
  if (!match.calendar_event_id && match.previous_event_id) {
    return { status: 'already_rescheduling', match };
  }

  return { status: 'ok', match };
}

/**
 * Performs the reschedule. Assumes checkRescheduleEligibility() already
 * returned 'ok' for this match — does not re-check.
 */
async function performReschedule(client, match) {
  resetBooking(match.id);
  console.log(`[reschedule] Match ${match.id} reset for rescheduling.`);

  // Force calendar_enabled so it runs regardless of the global setting (the
  // user already had a booked meeting, Azure is working). richVariety gives
  // a wider, more varied spread than the initial round suggestion.
  const users    = getMatchUsers(match.id);
  const settings = { ...getSettings(), calendar_enabled: true };

  await suggestMeetingTimes(
    client, match.slack_dm_channel_id, match.id, users, settings, false, { richVariety: true },
  );
}

// ── Button click handler ────────────────────────────────────────────────────

async function handleReschedule({ action, ack, body, client }) {
  await ack();

  const matchId = parseInt(action.value, 10);
  if (isNaN(matchId)) {
    console.error('[reschedule] Invalid matchId in button value:', action.value);
    return;
  }

  const channelId = body.channel.id;
  const messageTs = body.message.ts;

  const check = checkRescheduleEligibility(matchId);

  if (check.status === 'not_found') {
    console.error('[reschedule] Match not found:', matchId);
    return;
  }
  if (check.status === 'pending') {
    await safeUpdate(client, channelId, messageTs,
      '⏳ A booking is just being confirmed — please wait a moment, then try again.');
    return;
  }
  if (check.status === 'already_rescheduling') {
    await safeUpdate(client, channelId, messageTs,
      '⏳ New time options were already posted — scroll up in this chat to pick a slot.');
    return;
  }

  // status === 'ok' — show the working indicator BEFORE the (slower) Graph
  // call, same ordering as before the refactor.
  await safeUpdate(client, channelId, messageTs, '🔄 *Rescheduling…* New time options are being prepared.');
  await performReschedule(client, check.match);
}

async function safeUpdate(client, channelId, ts, text) {
  try {
    await client.chat.update({ channel: channelId, ts, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
  } catch (err) {
    console.warn('[reschedule] Could not update message:', err.message);
  }
}

module.exports = { handleReschedule, checkRescheduleEligibility, performReschedule };
