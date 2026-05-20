'use strict';

const { getUserBySlackId, updateUser } = require('../../lib/users');

async function leave(command, respond) {
  const { user_id } = command;
  const user = getUserBySlackId(user_id);

  if (!user || !user.is_active) {
    await respond("You're not a Watercooler participant, so there's nothing to leave.");
    return;
  }

  updateUser(user_id, { is_active: 0 });
  await respond(
    "👋 You've left Watercooler and won't be matched in future rounds. You can rejoin anytime with `/watercooler join`."
  );
}

module.exports = leave;
