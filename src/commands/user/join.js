'use strict';

const { getUserBySlackId, createUser, updateUser, isUserExcluded } = require('../../lib/users');

async function join(command, respond) {
  const { user_id, user_name } = command;

  // Admins can block a user from self-joining via /watercooler admin exclude
  if (isUserExcluded(user_id)) {
    await respond(
      "⛔ You've been excluded from Watercooler by an admin. Reach out to them if you think this is a mistake."
    );
    return;
  }

  const user = getUserBySlackId(user_id);

  if (!user) {
    // First time joining
    createUser(user_id, user_name);
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
  updateUser(user_id, { is_active: 1, is_paused: 0 });
  await respond("👋 Welcome back! You've rejoined Watercooler and will be matched in the next round.");
}

module.exports = join;
