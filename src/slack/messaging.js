'use strict';

// Slack API calls for Phase 6 — isolated here so the run handler stays readable.
//
// Two responsibilities:
//   1. openGroupDm  — create (or retrieve) the multi-person DM channel
//   2. postIntroMessage — send the Watercooler intro into that channel
//
// Both functions accept a `client` argument (Bolt's Web API client) so they
// can be called with a real client in production or a mock client in tests.

/**
 * Opens a Slack DM or group DM for the given user IDs and returns the channel ID.
 *
 * Slack behaviour:
 *   - 1 user  → opens a 1:1 DM between the bot and that user (rarely used here)
 *   - 2 users → opens a 1:1 DM between the two users via the bot
 *   - 3+ users → creates/retrieves an mpim (multi-person DM)
 *
 * If the channel already exists Slack returns the existing one — safe to call twice.
 *
 * Required scopes: im:write (1:1) and mpim:write (group)
 */
async function openGroupDm(client, slackUserIds) {
  const result = await client.conversations.open({
    users: slackUserIds.join(','),
  });

  if (!result.ok || !result.channel?.id) {
    throw new Error(`conversations.open failed: ${JSON.stringify(result)}`);
  }

  return result.channel.id;
}

/**
 * Posts the Watercooler intro message into a DM channel.
 * Required scope: chat:write
 *
 * @param {boolean} testMode  When true, appends a "this is a test" note
 */
async function postIntroMessage(client, channelId, users, testMode = false) {
  const text = buildIntroMessage(users, testMode);

  const result = await client.chat.postMessage({
    channel: channelId,
    text,
  });

  if (!result.ok) {
    throw new Error(`chat.postMessage failed: ${JSON.stringify(result)}`);
  }
}

// ── Message content ───────────────────────────────────────────────────────────

/**
 * Builds the intro message for a match group.
 * Exported so it can be unit tested without a Slack client.
 *
 * @param {object[]} users
 * @param {boolean}  testMode  When true, appends a test-run disclaimer
 */
function buildIntroMessage(users, testMode = false) {
  const names  = formatNameList(users.map((u) => u.display_name));
  const isTrio = users.length > 2;

  const body = isTrio
    ? "I've matched you all for a Watercooler chat! Find a time that works for everyone and have a virtual coffee. ☕"
    : "I've matched you for a Watercooler chat! Find a time that works for you both and catch up. ☕";

  const intro = `👋 Hi ${names}! ${body}`;

  return testMode
    ? `${intro}\n\n_🧪 *Test run* — we're verifying the full system. Please try clicking a meeting time below to help us test the booking flow. You won't actually need to meet up, and you can delete this message once you're done. Thank you!_`
    : intro;
}

/**
 * Formats a list of names as a natural English list:
 *   ["Alice"]                → "Alice"
 *   ["Alice", "Bob"]         → "Alice and Bob"
 *   ["Alice", "Bob", "Carol"] → "Alice, Bob, and Carol"
 */
function formatNameList(names) {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

module.exports = { openGroupDm, postIntroMessage, buildIntroMessage, formatNameList };
