'use strict';

// Handles: /watercooler admin resend-suggestions <matchId>
//
// Re-posts the calendar slot-selection buttons to a match DM. Useful when
// the original suggestions failed (Azure hiccup, email not resolved, etc.).
//
// Requires a matchId — there is no bulk form since suggestions are only
// meaningful per-match (each pair has its own free/busy window).
//
// Notes:
//   • Forces calendar_enabled = true regardless of the setting — admin override.
//   • If a previous suggestion message exists it stays in the DM (old buttons
//     still work). The DB's calendar_suggestion_ts is updated to the new message
//     so the auto-booker targets the latest one.
//   • Does not resend if the match is already booked.

const { getGraphClient }      = require('../../integrations/msGraph');
const { suggestMeetingTimes } = require('../../integrations/calendarScheduler');
const { getMatch, getMatchUsers, getSettings } = require('../../lib/rounds');

async function resendSuggestions(command, args, respond, client) {
  const matchIdRaw = (args || '').trim();
  const matchId    = matchIdRaw ? parseInt(matchIdRaw, 10) : null;

  if (!matchIdRaw) {
    await respond(
      '❌ A match ID is required.\n' +
      'Usage: `/watercooler admin resend-suggestions <matchId>`\n' +
      'Use `list-matches` to find valid IDs.'
    );
    return;
  }
  if (isNaN(matchId)) {
    await respond(`❌ Invalid match ID \`${matchIdRaw}\`. Use \`list-matches\` to find valid IDs.`);
    return;
  }

  const graphClient = getGraphClient();
  if (!graphClient) {
    await respond('❌ Azure credentials are missing — cannot query free/busy without a Graph connection. Check your `.env` file.');
    return;
  }

  const match = getMatch(matchId);

  if (!match) {
    await respond(`❌ Match #${matchId} not found. Use \`list-matches\` to see valid IDs.`);
    return;
  }
  if (!match.slack_dm_channel_id) {
    await respond(`❌ Match #${matchId} has no DM channel — nothing to post to.`);
    return;
  }
  if (match.calendar_event_id) {
    await respond(`⚠️ Match #${matchId} is already booked. No need to resend suggestions.`);
    return;
  }

  const users    = getMatchUsers(matchId);
  const settings = getSettings();

  // Force calendar on regardless of the admin toggle — this is an explicit override
  const settingsOverride = { ...settings, calendar_enabled: true };

  try {
    await suggestMeetingTimes(client, match.slack_dm_channel_id, matchId, users, settingsOverride);
    await respond(`✅ Slot suggestions re-posted for match #${matchId}.`);
  } catch (err) {
    await respond(`❌ Failed to resend suggestions for match #${matchId}: ${err.message}`);
  }
}

module.exports = { resendSuggestions };
