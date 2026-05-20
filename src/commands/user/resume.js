'use strict';

const { getUserBySlackId, updateUser } = require('../../lib/users');

async function resume(command, respond) {
  const { user_id } = command;
  const user = getUserBySlackId(user_id);

  if (!user || !user.is_active) {
    await respond(
      "You're not a Watercooler participant yet. Type `/watercooler join` to get started."
    );
    return;
  }

  if (!user.is_paused) {
    await respond("You're not paused — you're already in the matching queue.");
    return;
  }

  updateUser(user_id, { is_paused: 0 });
  await respond("▶️ You're back! You'll be included in the next Watercooler round.");
}

module.exports = resume;
