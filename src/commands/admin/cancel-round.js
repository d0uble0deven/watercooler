'use strict';

// Handles: /watercooler admin cancel-round [roundId]
//
// Without roundId — cancels the most recent non-cancelled round.
// With roundId    — cancels that specific round.
//
// For each match in the round:
//   • Deletes the calendar event via Graph API (if booked and Azure is configured)
//   • Updates the slot-suggestion Slack message to remove stale buttons
//   • Posts a warm cancellation notice to the match DM
//
// Marks the round as 'cancelled' in the DB so it is excluded from all
// future scheduling, auto-booking, and completion checks.

const { getGraphClient } = require('../../integrations/msGraph');
const {
  getMatchUsers,
  getSettings,
  getRoundById,
  getMostRecentActiveRound,
  getMatchesForRound,
  markRoundCancelled,
} = require('../../lib/rounds');

async function cancelRound(command, args, respond, client) {
  const roundIdRaw = (args || '').trim();
  const roundId    = roundIdRaw ? parseInt(roundIdRaw, 10) : null;

  if (roundIdRaw && isNaN(roundId)) {
    await respond(`❌ Invalid round ID \`${roundIdRaw}\`. Use \`list-matches\` to see recent round IDs.`);
    return;
  }

  const round = roundId ? getRoundById(roundId) : getMostRecentActiveRound();

  if (!round) {
    await respond(roundId
      ? `❌ Round #${roundId} not found.`
      : '❌ No active rounds found to cancel.'
    );
    return;
  }
  if (round.status === 'cancelled') {
    await respond(`⚠️ Round #${round.id} is already cancelled.`);
    return;
  }

  const matches     = getMatchesForRound(round.id);
  const settings    = getSettings();
  const graphClient = getGraphClient(); // may be null — event deletion is best-effort

  await respond(`⏳ Cancelling round #${round.id} (${matches.length} match(es))...`);

  let eventsDeleted = 0;
  let eventsFailed  = 0;
  let dmsNotified   = 0;

  for (const match of matches) {
    // ── Delete calendar event ──────────────────────────────────────────────
    let eventWasDeleted = false;

    if (match.calendar_event_id && graphClient) {
      try {
        const users          = getMatchUsers(match.id);
        const organizerEmail = users.find((u) => u.slack_email)?.slack_email;

        if (organizerEmail) {
          await graphClient
            .api(`/users/${encodeURIComponent(organizerEmail)}/events/${encodeURIComponent(match.calendar_event_id)}`)
            .delete();
          eventsDeleted++;
          eventWasDeleted = true;
        }
      } catch (err) {
        console.warn(`[cancel-round] Could not delete calendar event for match ${match.id}:`, err.message);
        eventsFailed++;
      }
    }

    if (!match.slack_dm_channel_id) continue;

    // ── Neutralise stale suggestion buttons ───────────────────────────────
    if (match.calendar_suggestion_ts) {
      try {
        await client.chat.update({
          channel: match.slack_dm_channel_id,
          ts:      match.calendar_suggestion_ts,
          text:    '🚫 These meeting suggestions have been cancelled.',
          blocks:  buildCancelledSuggestionBlocks(),
        });
      } catch (err) {
        // Non-critical — old buttons may linger but won't cause harm
        console.warn(`[cancel-round] Could not update suggestion message for match ${match.id}:`, err.message);
      }
    }

    // ── Post cancellation notice to DM ────────────────────────────────────
    try {
      await client.chat.postMessage({
        channel: match.slack_dm_channel_id,
        text:    '🚫 This intro has been cancelled.',
        blocks:  buildCancellationNoticeBlocks(eventWasDeleted),
      });
      dmsNotified++;
    } catch (err) {
      console.warn(`[cancel-round] Could not notify DM for match ${match.id}:`, err.message);
    }
  }

  markRoundCancelled(round.id);
  console.log(`[cancel-round] Round ${round.id} cancelled by ${command.user_id}.`);

  // ── Summary reply ─────────────────────────────────────────────────────────
  const lines = [`✅ *Round #${round.id} cancelled.*`];
  if (matches.length > 0)  lines.push(`• ${dmsNotified}/${matches.length} match DM(s) notified`);
  if (eventsDeleted > 0)   lines.push(`• ${eventsDeleted} calendar event(s) deleted`);
  if (eventsFailed > 0)    lines.push(`• ⚠️ ${eventsFailed} calendar event(s) could not be deleted — participants may need to remove them manually`);
  if (!graphClient && matches.some((m) => m.calendar_event_id)) {
    lines.push('• ⚠️ Azure credentials not configured — calendar events were _not_ deleted');
  }

  await respond(lines.join('\n'));
}

// ── Message builders ──────────────────────────────────────────────────────────

function buildCancellationNoticeBlocks(calendarEventDeleted) {
  const calendarLine = calendarEventDeleted
    ? 'The calendar event has been removed. '
    : '';

  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        '🚫 *This intro has been cancelled.*\n\n' +
        calendarLine +
        "No action needed — you'll be matched again in the next round. ☕",
    },
  }];
}

function buildCancelledSuggestionBlocks() {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '🚫 _These meeting suggestions have been cancelled._',
    },
  }];
}

module.exports = { cancelRound };
