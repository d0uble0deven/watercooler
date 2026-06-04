'use strict';

// Handles: /watercooler admin force-book [matchId]
//
// Without matchId — books every unbooked match from completed rounds now,
//   bypassing the normal booking-deadline wait.
// With matchId    — books that specific match immediately.
//
// Reuses autoBookMatch() from calendarAutoBooker, which finds a free slot,
// creates the calendar event + Teams link, and updates the Slack DM.

const { getGraphClient }  = require('../../integrations/msGraph');
const { autoBookMatch }   = require('../../integrations/calendarAutoBooker');
const { getMatch, getSettings, getAllUnbookedMatches } = require('../../lib/rounds');

async function forceBook(command, args, respond, client) {
  const graphClient = getGraphClient();
  if (!graphClient) {
    await respond('❌ Azure credentials are missing — cannot book without a Graph connection. Check your `.env` file.');
    return;
  }

  const settings   = getSettings();
  const matchIdRaw = (args || '').trim();
  const matchId    = matchIdRaw ? parseInt(matchIdRaw, 10) : null;

  if (matchIdRaw && isNaN(matchId)) {
    await respond(`❌ Invalid match ID \`${matchIdRaw}\`. Use \`list-matches\` to find valid IDs.`);
    return;
  }

  if (matchId) {
    await bookSingle(matchId, matchIdRaw, client, graphClient, settings, respond);
  } else {
    await bookAll(client, graphClient, settings, respond);
  }
}

// ── Single match ──────────────────────────────────────────────────────────────

async function bookSingle(matchId, rawArg, client, graphClient, settings, respond) {
  if (isNaN(matchId)) {
    await respond(`❌ Invalid match ID \`${rawArg}\`. Use \`list-matches\` to find valid IDs.`);
    return;
  }

  const match = getMatch(matchId);

  if (!match) {
    await respond(`❌ Match #${matchId} not found. Use \`list-matches\` to see valid IDs.`);
    return;
  }
  if (match.calendar_event_id) {
    await respond(`⚠️ Match #${matchId} is already booked. Use \`list-matches\` to check its current state.`);
    return;
  }
  if (!match.slack_dm_channel_id) {
    await respond(`❌ Match #${matchId} has no DM channel — cannot post the booking confirmation.`);
    return;
  }

  try {
    await autoBookMatch(client, graphClient, match, settings);
  } catch (err) {
    await respond(`❌ Failed to book match #${matchId}: ${err.message}`);
    return;
  }

  // Re-query to confirm the booking was actually persisted
  const updated = getMatch(matchId);
  if (updated.calendar_event_id) {
    await respond(`✅ Match #${matchId} booked successfully.`);
  } else {
    await respond(
      `⚠️ Match #${matchId}: no free shared slot found or participant emails are missing. ` +
      'A message has been posted to their DM. Check server logs for details.'
    );
  }
}

// ── All unbooked ──────────────────────────────────────────────────────────────

async function bookAll(client, graphClient, settings, respond) {
  const unbooked = getAllUnbookedMatches();

  if (unbooked.length === 0) {
    await respond('✅ No unbooked matches found — nothing to do.');
    return;
  }

  await respond(`⏳ Force-booking ${unbooked.length} unbooked match(es)...`);

  const errors = [];
  for (const match of unbooked) {
    try {
      await autoBookMatch(client, graphClient, match, settings);
    } catch (err) {
      errors.push(`• #${match.id}: ${err.message}`);
    }
  }

  // Re-check how many actually got a calendar event written
  const booked    = unbooked.filter((m) => !!getMatch(m.id).calendar_event_id).length;
  const notBooked = unbooked.length - booked;

  let msg = `✅ Done: *${booked}* booked`;
  if (notBooked > 0) msg += `, *${notBooked}* could not be booked (no free slots or missing emails)`;
  if (errors.length > 0) msg += `\n\n*Errors:*\n${errors.join('\n')}`;

  await respond(msg);
}

module.exports = { forceBook };
