'use strict';

// Handles: /watercooler admin summary
// Shows participant counts and round history at a glance.

const { getParticipantCounts } = require('../../lib/rounds');

async function summary(command, respond) {
  const c = getParticipantCounts();

  const lastRound = c.lastRoundDate
    ? new Date(c.lastRoundDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '_never_';

  await respond([
    '*📊 Watercooler Summary*',
    '',
    `• Eligible for next match: *${c.eligible}*`,
    `• Paused (sitting out):    *${c.paused}*`,
    `• Admin-excluded:          *${c.excluded}*`,
    `• Total active members:    *${c.totalActive}*`,
    '',
    `• Completed rounds: *${c.completedRounds}*`,
    `• Last round ran:   *${lastRound}*`,
    '',
    '_Run `/watercooler admin participants` to see the full eligible list._',
  ].join('\n'));
}

module.exports = summary;
