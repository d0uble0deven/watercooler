'use strict';

// Decline watcher.
//
// When someone declines a Watercooler calendar invite in Outlook, the decline
// often happens silently ("don't send a response"), so their match partner is
// left waiting for a meeting that won't happen. This module polls Microsoft
// Graph for attendee responses on booked, upcoming meetings and — the first
// time a decline is seen — posts a friendly nudge with a 🔄 Reschedule button
// into the match DM.
//
// Design notes:
//   • Called from the scheduler tick, but internally throttled to one Graph
//     sweep per POLL_INTERVAL_MS — no need to poll every minute.
//   • decline_notified_at is stamped BEFORE posting (same safe direction as
//     the no-slots fix): a crash after stamping costs one message, a crash
//     after posting-but-before-stamping would repeat forever.
//   • A vanished event (404 — deleted directly in Outlook) is also stamped:
//     there is nothing left to watch, and retrying forever just burns quota.
//   • Decline-then-re-accept before a poll simply never triggers — we only
//     act on the CURRENT response state.

const { getGraphClient } = require('./msGraph');
const {
  getBookedFutureMatches,
  getMatchUsers,
  markDeclineNotified,
} = require('../lib/rounds');

const POLL_INTERVAL_MS = 10 * 60 * 1000; // one Graph sweep per 10 minutes
let lastSweepAt = 0;

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Run on every scheduler tick; internally no-ops unless POLL_INTERVAL_MS has
 * elapsed since the last sweep.
 *
 * @param {object}  client    Bolt Web API client (app.client)
 * @param {object}  settings  Settings row from the DB
 * @param {object}  [opts]    { force: true } bypasses the throttle (tests)
 */
async function runDeclineCheck(client, settings, opts = {}) {
  if (!settings.calendar_enabled) return;

  if (!opts.force && Date.now() - lastSweepAt < POLL_INTERVAL_MS) return;
  lastSweepAt = Date.now();

  const graphClient = getGraphClient();
  if (!graphClient) return;

  const matches = getBookedFutureMatches();
  if (matches.length === 0) return;

  for (const match of matches) {
    try {
      await checkMatchForDeclines(client, graphClient, match);
    } catch (err) {
      // Transient Graph/Slack error — leave unstamped so the next sweep retries
      console.warn(`[declineWatcher] Check failed for match ${match.id}:`, err.message);
    }
  }
}

// ── Per-match check ───────────────────────────────────────────────────────────

async function checkMatchForDeclines(client, graphClient, match) {
  const users     = getMatchUsers(match.id);
  const organizer = users.find((u) => u.slack_email)?.slack_email;
  if (!organizer) return;

  let event;
  try {
    event = await graphClient
      .api(`/users/${encodeURIComponent(organizer)}/events/${encodeURIComponent(match.calendar_event_id)}`)
      .select('attendees')
      .get();
  } catch (err) {
    if (err.statusCode === 404) {
      // Event was deleted outside the app — nothing left to watch
      console.warn(`[declineWatcher] Event for match ${match.id} no longer exists — retiring from watch.`);
      markDeclineNotified(match.id);
      return;
    }
    throw err;
  }

  const declinedEmails = (event.attendees || [])
    .filter((a) => a.status?.response === 'declined')
    .map((a) => (a.emailAddress?.address || '').toLowerCase());

  if (declinedEmails.length === 0) return;

  const declinedNames = declinedEmails.map((email) => {
    const user = users.find((u) => (u.slack_email || '').toLowerCase() === email);
    return user?.display_name || email;
  });

  // Stamp first — the safe failure direction (see module notes)
  markDeclineNotified(match.id);

  await client.chat.postMessage({
    channel: match.slack_dm_channel_id,
    text:    `👀 Looks like this time doesn't work for ${declinedNames.join(' and ')}.`,
    blocks:  buildDeclineMessage(match.id, declinedNames),
  });

  console.log(`[declineWatcher] Match ${match.id}: decline by ${declinedNames.join(', ')} — reschedule nudge posted.`);
}

// ── Message builder ───────────────────────────────────────────────────────────

/**
 * Block Kit blocks for the decline nudge. Reuses the existing reschedule
 * action — clicking the button runs the exact same flow as the 🔄 button on
 * the booking confirmation.
 */
function buildDeclineMessage(matchId, declinedNames) {
  const names = declinedNames.join(' and ');

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `👀 Looks like this time doesn't work for *${names}* — want to pick a new one?`,
      },
    },
    {
      type:     'actions',
      elements: [{
        type:      'button',
        text:      { type: 'plain_text', text: '🔄 Reschedule', emoji: true },
        value:     String(matchId),
        action_id: 'watercooler_reschedule',
      }],
    },
    {
      type:     'context',
      elements: [{
        type: 'mrkdwn',
        text: '_Rescheduling posts fresh time options here. The current invite stays on calendars until a new time is booked._',
      }],
    },
  ];
}

module.exports = { runDeclineCheck, buildDeclineMessage };
