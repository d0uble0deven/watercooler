'use strict';

// Handles:
//   /watercooler admin exclude @user  — add to exclusion list
//   /watercooler admin include @user  — remove from exclusion list
//
// Exclusions are stored in the `exclusions` table.
// They prevent a user from being matched even if they have is_active = 1.
// The user can still see their own excluded status via /watercooler status.

const { addExclusion, removeExclusion, isUserExcluded } = require('../../lib/users');

// ── exclude ───────────────────────────────────────────────────────────────────

async function exclude(command, args, respond) {
  const userId = parseUserMention(args);

  if (!userId) {
    await respond(
      '❌ Please specify a user to exclude.\n' +
      'Example: `/watercooler admin exclude @alice` or `/watercooler admin exclude U01ABC123`'
    );
    return;
  }

  if (isUserExcluded(userId)) {
    await respond(`⚠️ <@${userId}> is already excluded from Watercooler.`);
    return;
  }

  addExclusion(userId, null, command.user_id);

  await respond(
    `✅ <@${userId}> has been excluded from Watercooler matching.\n` +
    `_They won't be included in future rounds. Use \`/watercooler admin include @user\` to reverse this._`
  );
}

// ── include ───────────────────────────────────────────────────────────────────

async function include(command, args, respond) {
  const userId = parseUserMention(args);

  if (!userId) {
    await respond(
      '❌ Please specify a user to include.\n' +
      'Example: `/watercooler admin include @alice` or `/watercooler admin include U01ABC123`'
    );
    return;
  }

  const result = removeExclusion(userId);

  if (result.changes === 0) {
    await respond(`⚠️ <@${userId}> isn't in the exclusion list — nothing to remove.`);
    return;
  }

  await respond(
    `✅ <@${userId}> has been removed from the exclusion list.\n` +
    `_They can now use \`/watercooler join\` to participate in matching._`
  );
}

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Extracts a Slack user ID from the args string.
 *
 * Accepts:
 *   "<@U01ABC123|alice>"  — Slack auto-expands @mentions in slash command text
 *   "<@U01ABC123>"        — bare mention
 *   "U01ABC123"           — raw user ID typed directly
 */
function parseUserMention(text) {
  if (!text) return null;

  // Slack-formatted mention: <@U01ABC123|username> or <@U01ABC123>
  const mentionMatch = (text || '').match(/<@([A-Z0-9]+)(?:\|[^>]*)?>/);
  if (mentionMatch) return mentionMatch[1];

  // Raw user ID: starts with a letter, alphanumeric, looks like a Slack ID
  const rawMatch = (text || '').trim().match(/^([A-Z][A-Z0-9]{5,})$/i);
  if (rawMatch) return rawMatch[1].toUpperCase();

  return null;
}

module.exports = { exclude, include };
