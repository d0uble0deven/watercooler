'use strict';

// Handles: /watercooler admin participants
// Lists everyone who will be included in the next matching round.

const { getActiveUsers } = require('../../lib/users');

async function participants(command, respond) {
  const users = getActiveUsers();

  if (users.length === 0) {
    await respond(
      'No eligible participants yet.\n' +
      'Have people opt in with `/watercooler join`.'
    );
    return;
  }

  const list = users.map((u) => `• ${u.display_name}  \`${u.slack_user_id}\``).join('\n');

  await respond([
    `*Active participants (${users.length}) — eligible for next match:*`,
    list,
  ].join('\n'));
}

module.exports = participants;
