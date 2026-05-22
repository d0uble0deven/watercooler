'use strict';

const { getUserBySlackId, createUser, updateUser, isUserExcluded } = require('../../lib/users');

async function join(command, respond, client) {
  const { user_id, user_name } = command;

  // Admins can block a user from self-joining via /watercooler admin exclude
  if (isUserExcluded(user_id)) {
    await respond(
      "⛔ You've been excluded from Watercooler by an admin. Reach out to them if you think this is a mistake."
    );
    return;
  }

  // Resolve the real name from the Slack profile so the DB stores
  // "Dev Govindji" rather than the username "dev.govindji".
  // Falls back to the command's user_name if the API call fails.
  let displayName = user_name;
  try {
    const info = await client.users.info({ user: user_id });
    displayName = info?.user?.profile?.real_name
               || info?.user?.profile?.display_name
               || user_name;
  } catch (err) {
    console.warn(`[join] Could not fetch real name for ${user_id} — using username:`, err.message);
  }

  const user = getUserBySlackId(user_id);

  if (!user) {
    // First time joining
    createUser(user_id, displayName);
    await respond("🎉 You've joined Watercooler! You'll be matched with someone in the next round.");
    return;
  }

  if (user.is_active && !user.is_paused) {
    await respond(
      "You're already participating in Watercooler. Use `/watercooler status` to see your current status."
    );
    return;
  }

  if (user.is_active && user.is_paused) {
    await respond(
      "You're currently paused. Use `/watercooler resume` to re-enter the matching queue."
    );
    return;
  }

  // is_active = 0 — they previously left; welcome them back
  // Also refresh their display name in case it changed
  updateUser(user_id, { is_active: 1, is_paused: 0, display_name: displayName });
  await respond("👋 Welcome back! You've rejoined Watercooler and will be matched in the next round.");
}

module.exports = join;
