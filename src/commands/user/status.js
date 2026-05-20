'use strict';

const { getUserBySlackId, isUserExcluded } = require('../../lib/users');

async function status(command, respond) {
  const { user_id } = command;

  if (isUserExcluded(user_id)) {
    await respond(
      "⛔ *Watercooler status: Excluded*\nAn admin has excluded you from matching. Reach out to them if you think this is a mistake."
    );
    return;
  }

  const user = getUserBySlackId(user_id);

  if (!user || !user.is_active) {
    await respond(
      "You're not participating in Watercooler. Type `/watercooler join` to opt in."
    );
    return;
  }

  if (user.is_paused) {
    await respond(
      "⏸ *Watercooler status: Paused*\nYou won't be included in the next round. Type `/watercooler resume` when you're ready to come back."
    );
    return;
  }

  await respond(
    "✅ *Watercooler status: Active*\nYou're in the queue and will be matched in the next round."
  );
}

module.exports = status;
