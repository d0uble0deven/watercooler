'use strict';

// Handles: /watercooler admin settings
// Displays the current app-wide configuration.

const { getSettings } = require('../../lib/rounds');

async function showSettings(command, respond) {
  const s = getSettings();

  const channel = s.intro_channel_id
    ? `*${s.intro_channel_id}*`
    : '_not set_';

  await respond([
    '*⚙️ Watercooler Settings*',
    '',
    `• Group size:            *${s.group_size}* — pairs, with one trio if participant count is odd`,
    `• Avoid repeat rounds:   *${s.avoid_repeat_rounds}* — won't re-pair someone within this many rounds`,
    `• Cadence:               *${s.cadence}*`,
    `• Intro day:             *${s.intro_day}*`,
    `• Intro time:            *${s.intro_time}*`,
    `• Intro channel:         ${channel}`,
    '',
    '*To update:*',
    '• `/watercooler admin set group-size <n>`',
    '• `/watercooler admin set avoid-repeat-rounds <n>`',
    '• `/watercooler admin set cadence weekly|biweekly|monthly`',
    '• `/watercooler admin set channel <channel-id>`',
  ].join('\n'));
}

module.exports = showSettings;
