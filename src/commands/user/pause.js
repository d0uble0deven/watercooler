'use strict';

const { getUserBySlackId, updateUser } = require('../../lib/users');

async function pause(command, respond) {
  const { user_id } = command;
  const user = getUserBySlackId(user_id);

  if (!user || !user.is_active) {
    await respond(
      "You're not a Watercooler participant yet. Type `/watercooler join` to get started."
    );
    return;
  }

  if (user.is_paused) {
    await respond(
      "You're already paused. Type `/watercooler resume` when you're ready to be matched again."
    );
    return;
  }

  updateUser(user_id, { is_paused: 1 });
  await respond(
    "⏸ You're now paused and won't be included in the next round. Type `/watercooler resume` whenever you're ready to come back."
  );
}

module.exports = pause;
