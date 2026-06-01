'use strict';

// Handles clicks on the three post-meeting feedback buttons:
//
//   watercooler_meeting_good   — "👍 It was good!"
//   watercooler_meeting_meh    — "👎 Meh"
//   watercooler_meeting_snooze — "🤗 Snooze intros"
//
// All three follow the same pattern:
//   1. ack() immediately so Slack doesn't show a warning triangle
//   2. Parse matchId from the button value
//   3. Persist the feedback to the DB
//   4. Replace the feedback buttons with a short confirmation message
//
// Snooze also pauses the user who clicked the button (equivalent to
// running /watercooler pause themselves).

const { saveFeedback, getMatch }  = require('../../lib/rounds');
const { getUserBySlackId, updateUser } = require('../../lib/users');

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleMeetingGood({ action, ack, body, client }) {
  await ack();

  const { matchId, channelId, messageTs } = parseAction(action, body);
  if (!matchId) return;

  saveFeedback(matchId, 'good');
  console.log(`[meetingFeedback] Match ${matchId} — feedback: good`);

  await safeUpdate(client, channelId, messageTs,
    '👍 Glad it went well!',
    buildGoodConfirmation()
  );
}

async function handleMeetingMeh({ action, ack, body, client }) {
  await ack();

  const { matchId, channelId, messageTs } = parseAction(action, body);
  if (!matchId) return;

  saveFeedback(matchId, 'meh');
  console.log(`[meetingFeedback] Match ${matchId} — feedback: meh`);

  await safeUpdate(client, channelId, messageTs,
    '👎 Thanks for the feedback.',
    buildMehConfirmation()
  );
}

async function handleMeetingSnooze({ action, ack, body, client }) {
  await ack();

  const { matchId, channelId, messageTs } = parseAction(action, body);
  if (!matchId) return;

  // Pause only the person who clicked — not the whole group
  const clickerId = body.user?.id;
  if (clickerId) {
    const user = getUserBySlackId(clickerId);
    if (user?.is_active) {
      updateUser(clickerId, { is_paused: 1 });
      console.log(`[meetingFeedback] Snoozed user ${clickerId} (match ${matchId})`);
    }
  }

  saveFeedback(matchId, 'snoozed');
  console.log(`[meetingFeedback] Match ${matchId} — feedback: snoozed`);

  await safeUpdate(client, channelId, messageTs,
    '🤗 No worries! You\'ve been snoozed.',
    buildSnoozeConfirmation()
  );
}

// ── Message builders (exported for testing) ───────────────────────────────────

function buildGoodConfirmation() {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '👍 *Glad it went well!* See you in the next round. ☕',
    },
  }];
}

function buildMehConfirmation() {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '👎 *Thanks for the feedback.* Hopefully the next one clicks better. ☕',
    },
  }];
}

function buildSnoozeConfirmation() {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        '🤗 *No worries!* You\'ve been snoozed and won\'t be included in the next round.\n' +
        'Run `/watercooler resume` whenever you\'re ready to come back.',
    },
  }];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseAction(action, body) {
  const matchId   = parseInt(action.value, 10);
  const channelId = body.channel?.id;
  const messageTs = body.message?.ts;

  if (isNaN(matchId)) {
    console.error('[meetingFeedback] Invalid matchId in button value:', action.value);
    return {};
  }
  return { matchId, channelId, messageTs };
}

async function safeUpdate(client, channelId, messageTs, text, blocks) {
  if (!channelId || !messageTs) return;
  try {
    await client.chat.update({ channel: channelId, ts: messageTs, text, blocks });
  } catch (err) {
    console.warn('[meetingFeedback] Could not update message:', err.message);
  }
}

module.exports = {
  handleMeetingGood,
  handleMeetingMeh,
  handleMeetingSnooze,
  buildGoodConfirmation,
  buildMehConfirmation,
  buildSnoozeConfirmation,
};
