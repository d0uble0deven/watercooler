'use strict';

// Handles: /watercooler admin send-completion [matchId]
//
// Without matchId — sends the post-meeting feedback message to every match
//   that hasn't received one yet, bypassing the normal time-based gate.
//   Also posts the round-complete summary to #virtual-coffee for any round
//   where all matches are now done.
// With matchId    — sends to that specific match immediately.

const {
  sendCompletionForMatch,
  postRoundSummaryIfComplete,
} = require('../../integrations/meetingCompleter');

const {
  getMatch,
  getSettings,
  getAllMatchesPendingCompletion,
} = require('../../lib/rounds');

async function sendCompletion(command, args, respond, client) {
  const settings   = getSettings();
  const matchIdRaw = (args || '').trim();
  const matchId    = matchIdRaw ? parseInt(matchIdRaw, 10) : null;

  if (matchIdRaw && isNaN(matchId)) {
    await respond(`❌ Invalid match ID \`${matchIdRaw}\`. Use \`list-matches\` to find valid IDs.`);
    return;
  }

  if (matchId) {
    await completeSingle(matchId, client, settings, respond);
  } else {
    await completeAll(client, settings, respond);
  }
}

// ── Single match ──────────────────────────────────────────────────────────────

async function completeSingle(matchId, client, settings, respond) {
  const match = getMatch(matchId);

  if (!match) {
    await respond(`❌ Match #${matchId} not found. Use \`list-matches\` to see valid IDs.`);
    return;
  }
  if (match.completion_message_sent) {
    await respond(`⚠️ Match #${matchId} already had a completion message sent.`);
    return;
  }
  if (!match.slack_dm_channel_id) {
    await respond(`❌ Match #${matchId} has no DM channel.`);
    return;
  }

  try {
    await sendCompletionForMatch(client, match, settings);
    await postRoundSummaryIfComplete(client, match.round_id, settings);
    await respond(`✅ Completion message sent for match #${matchId}.`);
  } catch (err) {
    await respond(`❌ Failed to send completion for match #${matchId}: ${err.message}`);
  }
}

// ── All pending ───────────────────────────────────────────────────────────────

async function completeAll(client, settings, respond) {
  const pending = getAllMatchesPendingCompletion();

  if (pending.length === 0) {
    await respond('✅ No matches pending completion — nothing to do.');
    return;
  }

  await respond(`⏳ Sending completion messages to ${pending.length} match(es)...`);

  let succeeded      = 0;
  const errors       = [];
  const affectedRounds = new Set();

  for (const match of pending) {
    try {
      await sendCompletionForMatch(client, match, settings);
      affectedRounds.add(match.round_id);
      succeeded++;
    } catch (err) {
      errors.push(`• #${match.id}: ${err.message}`);
    }
  }

  // Post round-complete summary to channel for any rounds now fully done
  for (const roundId of affectedRounds) {
    try {
      await postRoundSummaryIfComplete(client, roundId, settings);
    } catch (err) {
      console.error(`[send-completion] Round summary failed for round ${roundId}:`, err.message);
    }
  }

  let msg = `✅ Done: *${succeeded}* completion message(s) sent`;
  if (errors.length > 0) msg += `\n\n*Errors:*\n${errors.join('\n')}`;
  await respond(msg);
}

module.exports = { sendCompletion };
