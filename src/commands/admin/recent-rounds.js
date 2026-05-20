'use strict';

// Handles: /watercooler admin recent-rounds
// Shows the last 5 completed matching rounds.

const { getRecentRounds } = require('../../lib/rounds');

async function recentRounds(command, respond) {
  const rounds = getRecentRounds(5);

  if (rounds.length === 0) {
    await respond(
      'No completed rounds yet.\n' +
      'Use `/watercooler admin dry-run` to preview a match, or `/watercooler admin run` to run one.'
    );
    return;
  }

  const lines = rounds.map((r, i) => {
    const date = new Date(r.started_at).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
    const groups       = r.match_count;
    const participants = r.participant_count;
    return `${i + 1}. *Round #${r.id}* — ${date} — ${groups} group(s), ${participants} participants`;
  });

  await respond([
    `*🕐 Recent rounds (last ${rounds.length}):*`,
    ...lines,
  ].join('\n'));
}

module.exports = recentRounds;
