'use strict';

// Handles: /watercooler admin paused
// Lists everyone who is opted in but currently sitting out of matching.

const { getPausedUsers } = require('../../lib/users');

async function paused(command, respond) {
  const users = getPausedUsers();

  if (users.length === 0) {
    await respond('Nobody is paused right now — everyone who has joined is eligible for matching. 👍');
    return;
  }

  const list = users.map((u) => `• ${u.display_name}  \`${u.slack_user_id}\``).join('\n');

  await respond([
    `*Paused participants (${users.length}) — sitting out of matching:*`,
    list,
    '',
    '_Paused users can resume with `/watercooler resume`._',
  ].join('\n'));
}

module.exports = paused;
