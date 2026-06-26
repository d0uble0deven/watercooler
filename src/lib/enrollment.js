'use strict';

// Shared enrollment logic for channel-based auto-enrollment.
//
// Both the channel event handlers (Step 3) and the backfill admin command
// (Step 4) funnel through `enrollUser` / `unenrollUser` so the filtering,
// welcome DM, and DB writes live in exactly one place.
//
// `enrollUser` returns a status string so callers can report what happened:
//   skipped_excluded — admin exclusion list wins over everything
//   skipped_bot      — bots, Slackbot, and deleted accounts
//   skipped_guest    — single/multi-channel guests
//   skipped_error    — couldn't read the Slack profile (transient)
//   already_active   — already enrolled; no-op, no DM
//   enrolled         — brand-new user created + welcome DM
//   reactivated      — previously-left user re-activated + welcome DM

const {
  getUserBySlackId,
  createUser,
  updateUser,
  isUserExcluded,
} = require('./users');

// ── Enroll ──────────────────────────────────────────────────────────────────

/**
 * Enrolls a user into Watercooler (or reactivates a returning one).
 *
 * @param {object} client       Bolt Web API client
 * @param {string} slackUserId  e.g. 'U01ABC123'
 * @param {'channel'|'sync'|'command'} source  how the enrollment was triggered
 * @returns {Promise<string>}    one of the status strings documented above
 */
async function enrollUser(client, slackUserId, source) {
  // 1. Admin exclusion overrides everything else.
  if (isUserExcluded(slackUserId)) return 'skipped_excluded';

  // 2. Read the Slack profile once — used for both filtering and display name.
  let profile;
  try {
    const info = await client.users.info({ user: slackUserId });
    profile = info?.user;
  } catch (err) {
    console.warn(`[enrollment] users.info failed for ${slackUserId}:`, err.message);
    return 'skipped_error';
  }

  if (!profile || profile.deleted || profile.is_bot || profile.id === 'USLACKBOT') {
    return 'skipped_bot';
  }
  if (profile.is_restricted || profile.is_ultra_restricted) {
    return 'skipped_guest';
  }

  const displayName =
    profile.profile?.real_name ||
    profile.profile?.display_name ||
    profile.name ||
    slackUserId;

  // 3. Create, reactivate, or no-op.
  const existing = getUserBySlackId(slackUserId);
  let status;

  if (!existing) {
    createUser(slackUserId, displayName);
    updateUser(slackUserId, { enrolled_via: source });
    status = 'enrolled';
  } else if (!existing.is_active) {
    updateUser(slackUserId, {
      is_active: 1,
      is_paused: 0,
      display_name: displayName,
      enrolled_via: source,
    });
    status = 'reactivated';
  } else {
    return 'already_active'; // already in the rotation — no DM, no churn
  }

  // 4. Welcome DM only for genuinely new/returning enrollments.
  await sendWelcomeDm(client, slackUserId);
  return status;
}

// ── Unenroll ────────────────────────────────────────────────────────────────

/**
 * Opts a user out (same end state as `/watercooler leave`). No DM — leaving
 * the channel is itself the signal, so messaging them would just be noise.
 *
 * @param {string} slackUserId
 * @returns {string} 'unenrolled' | 'not_enrolled'
 */
function unenrollUser(slackUserId) {
  const existing = getUserBySlackId(slackUserId);
  if (!existing || !existing.is_active) return 'not_enrolled';
  updateUser(slackUserId, { is_active: 0 });
  return 'unenrolled';
}

// ── Welcome DM ──────────────────────────────────────────────────────────────

async function sendWelcomeDm(client, slackUserId) {
  try {
    const im = await client.conversations.open({ users: slackUserId });
    const channel = im?.channel?.id;
    if (!channel) return;
    await client.chat.postMessage({
      channel,
      text: 'Welcome to Watercooler! ☕',
      blocks: buildWelcomeBlocks(),
    });
  } catch (err) {
    // Non-fatal — enrollment still succeeded even if the DM didn't land.
    console.warn(`[enrollment] Could not send welcome DM to ${slackUserId}:`, err.message);
  }
}

function buildWelcomeBlocks() {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        "☕ *Welcome to Watercooler!*\n\n" +
        "You joined the channel, so you're now in the rotation — every few weeks " +
        "you'll be matched with a teammate for a casual 15-minute coffee chat.\n\n" +
        "No action needed. To sit out a round use `/watercooler pause`; " +
        "to opt out entirely just leave the channel.",
    },
  }];
}

module.exports = { enrollUser, unenrollUser, buildWelcomeBlocks };
