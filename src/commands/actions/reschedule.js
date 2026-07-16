'use strict';

// Reschedule flow — reachable two ways:
//   1. Clicking the "🔄 Reschedule" button on a booking confirmation message.
//   2. Running /watercooler reschedule (src/commands/user/reschedule.js),
//      which finds the user's match and reuses this same core logic.
//
// Both call checkRescheduleEligibility() + performReschedule() below, so the
// guard conditions and the reset/re-suggest behavior only exist in one place.
//
// PRIVACY MODEL — rescheduling is silent until a new time is actually booked:
//   • New slot options are posted EPHEMERALLY (visible only to the requester).
//   • The shared "✅ Meeting booked!" confirmation is left untouched, so the
//     match partner sees no change — and the old Teams link keeps working,
//     which is correct: nothing has actually changed for them yet.
//   • The old calendar event survives until a new slot is picked; bookSlot
//     deletes it then via previous_event_id.
//   • The partner finds out at the moment a new time is booked — the normal
//     public confirmation for the new slot.
//
// Flow:
//   1. Guard: bail if a booking is in-flight ('pending').
//   2. resetBooking() — copies calendar_event_id → previous_event_id, clears
//      booking fields. Skipped if already mid-reschedule (would clobber the
//      pointer to the original event that still needs deleting).
//   3. suggestMeetingTimes in rich + private mode — more slots, more spread,
//      visible only to the requester.

const { getMatch, getMatchUsers, resetBooking, getSettings } = require('../../lib/rounds');
const { suggestMeetingTimes } = require('../../integrations/calendarScheduler');

/**
 * Guard-only check — no side effects. Both entry points call this first so
 * they can show the right message (or bail) before touching anything.
 *
 * 'already_rescheduling' is NOT an error — it means the match was already
 * reset and is awaiting a slot pick. Callers should still repost fresh options
 * (via performReschedule, which skips the redundant reset).
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
 * Performs the reschedule and posts fresh options privately to `requesterId`.
 * Assumes checkRescheduleEligibility() returned 'ok' or 'already_rescheduling'.
 *
 * @param {object} client       Bolt Web API client
 * @param {object} match        Match row
 * @param {string} requesterId  Slack user ID — sees the ephemeral options
 */
async function performReschedule(client, match, requesterId) {
  // Only reset if there's a live booking to clear. Re-running against a match
  // that's already mid-reschedule would overwrite previous_event_id with NULL,
  // orphaning the original calendar event (it would never get deleted).
  if (match.calendar_event_id) {
    resetBooking(match.id);
    console.log(`[reschedule] Match ${match.id} reset for rescheduling.`);
  } else {
    console.log(`[reschedule] Match ${match.id} already awaiting a slot — reposting options only.`);
  }

  // Force calendar_enabled so it runs regardless of the global setting (the
  // user already had a booked meeting, Azure is working). richVariety gives
  // a wider, more varied spread than the initial round suggestion.
  const users    = getMatchUsers(match.id);
  const settings = { ...getSettings(), calendar_enabled: true };

  await suggestMeetingTimes(
    client, match.slack_dm_channel_id, match.id, users, settings, false,
    { richVariety: true, privateToUserId: requesterId },
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

  const channelId  = body.channel.id;
  const requesterId = body.user?.id;

  const check = checkRescheduleEligibility(matchId);

  if (check.status === 'not_found') {
    console.error('[reschedule] Match not found:', matchId);
    return;
  }
  if (check.status === 'pending') {
    await safeEphemeral(client, channelId, requesterId,
      '⏳ A booking is just being confirmed — please wait a moment, then try again.');
    return;
  }

  // 'ok' or 'already_rescheduling' — either way, post fresh private options.
  // The shared confirmation message is deliberately left untouched so the
  // match partner isn't notified until a new time is actually booked.
  await performReschedule(client, check.match, requesterId);
}

/**
 * Posts a plain ephemeral note to one user. Used for the guard messages —
 * never edits the shared confirmation message, which would leak the fact
 * that someone is rescheduling.
 */
async function safeEphemeral(client, channelId, userId, text) {
  if (!userId) return;
  try {
    await client.chat.postEphemeral({
      channel: channelId,
      user:    userId,
      text,
      blocks:  [{ type: 'section', text: { type: 'mrkdwn', text } }],
    });
  } catch (err) {
    console.warn('[reschedule] Could not post ephemeral message:', err.message);
  }
}

module.exports = { handleReschedule, checkRescheduleEligibility, performReschedule, safeEphemeral };
