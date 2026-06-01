'use strict';

// Handles: /watercooler admin settings
// Displays the current app-wide configuration.

const { getSettings } = require('../../lib/rounds');

async function showSettings(command, respond) {
  const s = getSettings();

  const channel        = s.intro_channel_id ? `*${s.intro_channel_id}*` : '_not set_';
  const calEnabled     = s.calendar_enabled  ? '*enabled* ✅' : '*disabled*';
  const dl             = s.booking_deadline ?? 2.5;
  const deadlineHours  = Math.floor(dl) * 24 + (dl % 1) * 8;
  const tz             = s.calendar_timezone ?? 'America/New_York';
  const fallbackDays   = s.completion_fallback_days ?? 12;

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
    '*📅 Calendar (Outlook integration):*',
    `• Calendar integration:  ${calEnabled}`,
    `• Meeting duration:      *${s.meeting_duration ?? 30} min*`,
    `• Booking deadline:      *${dl} day(s)* _(${deadlineHours}h before intro DM)_`,
    `• Calendar timezone:     *${tz}*`,
    `• Completion fallback:   *${fallbackDays} business day${fallbackDays === 1 ? '' : 's'}* _(post-meeting message fires after this window)_`,
    '',
    '*To update:*',
    '• `/watercooler admin set group-size <n>`',
    '• `/watercooler admin set avoid-repeat-rounds <n>`',
    '• `/watercooler admin set cadence weekly|biweekly|triweekly|monthly`',
    '• `/watercooler admin set channel <channel-id>`',
    '• `/watercooler admin set calendar-enabled true|false`',
    '• `/watercooler admin set meeting-duration 15|30|45|60`',
    '• `/watercooler admin set booking-deadline <days>`',
    '• `/watercooler admin set calendar-timezone <iana-tz>`',
    '• `/watercooler admin set completion-fallback-days <n>`',
  ].join('\n'));
}

module.exports = showSettings;
