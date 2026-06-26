'use strict';

// Handles: /watercooler admin set <setting> <value>
//
// Supported settings:
//   set group-size <n>              — n must be >= 2
//   set avoid-repeat-rounds <n>     — n must be >= 0
//   set cadence weekly|biweekly|triweekly|monthly
//   set channel <channel-id>        — use a Slack channel ID (C...) for reliability
//   set intro-day <day-name>        — day of week the scheduler fires
//   set intro-time <HH:MM>          — time of day the scheduler fires (24-hour)
//   set calendar-enabled true|false — toggle Outlook calendar integration
//   set meeting-duration <minutes>  — 15 | 30 | 45 | 60
//   set booking-deadline <days>     — decimal days before intro DM to auto-book (e.g. 2.5)
//   set calendar-timezone <tz>      — IANA timezone for meeting time display (e.g. America/Chicago)
//   set completion-fallback-days <n> — business days after round before fallback completion fires (default 12)

const { updateSettings, getSettings } = require('../../lib/rounds');

const SET_HELP = [
  '*Available settings:*',
  '• `/watercooler admin set group-size <n>` — pair size (must be ≥ 2)',
  '• `/watercooler admin set avoid-repeat-rounds <n>` — repeat-avoidance window (0 = off)',
  '• `/watercooler admin set cadence weekly|biweekly|triweekly|monthly`',
  '• `/watercooler admin set channel <channel-id>` — channel for automated announcements',
  '• `/watercooler admin set intro-day <day>` — day the scheduler fires (e.g. `monday`)',
  '• `/watercooler admin set intro-time <HH:MM>` — time the scheduler fires (24-hour)',
  '',
  '*Calendar settings (Phase 10):*',
  '• `/watercooler admin set calendar-enabled true|false` — toggle Outlook calendar integration',
  '• `/watercooler admin set meeting-duration <minutes>` — 15, 30, 45, or 60',
  '• `/watercooler admin set booking-deadline <days>` — days before intro to auto-book (e.g. `2.5`)',
  '• `/watercooler admin set calendar-timezone <tz>` — IANA timezone for meeting time display (e.g. `America/Chicago`)',
  '• `/watercooler admin set completion-fallback-days <n>` — business days after round before fallback fires (default `12`)',
  '',
  '*Enrollment:*',
  '• `/watercooler admin set enrollment manual|channel` — how people join (manual = slash command only; channel = joining the intro channel enrolls them)',
].join('\n');

async function set(command, args, respond) {
  // args = everything after "set", e.g. "group-size 3"
  const [setting, ...valueParts] = (args || '').trim().split(/\s+/);
  const value = valueParts.join(' ').trim();

  switch ((setting || '').toLowerCase()) {
    case 'group-size':          return await setGroupSize(value, respond);
    case 'avoid-repeat-rounds': return await setAvoidRepeatRounds(value, respond);
    case 'cadence':             return await setCadence(value, respond);
    case 'channel':             return await setChannel(value, respond);
    case 'intro-day':           return await setIntroDay(value, respond);
    case 'intro-time':          return await setIntroTime(value, respond);
    case 'calendar-enabled':    return await setCalendarEnabled(value, respond);
    case 'meeting-duration':    return await setMeetingDuration(value, respond);
    case 'booking-deadline':    return await setBookingDeadline(value, respond);
    case 'calendar-timezone':        return await setCalendarTimezone(value, respond);
    case 'completion-fallback-days': return await setCompletionFallbackDays(value, respond);
    case 'enrollment':               return await setEnrollment(value, respond);
    default:
      return await respond(
        `❌ Unknown setting: \`${setting || '(none)'}\`\n\n${SET_HELP}`
      );
  }
}

// ── Individual setters ────────────────────────────────────────────────────────

async function setGroupSize(value, respond) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 2) {
    await respond('❌ `group-size` must be a whole number ≥ 2.\nExample: `/watercooler admin set group-size 2`');
    return;
  }
  updateSettings({ group_size: n });
  await respond(`✅ Group size updated to *${n}*. The next run will use this value.`);
}

async function setAvoidRepeatRounds(value, respond) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 0) {
    await respond('❌ `avoid-repeat-rounds` must be a whole number ≥ 0.\nExample: `/watercooler admin set avoid-repeat-rounds 4`');
    return;
  }
  updateSettings({ avoid_repeat_rounds: n });
  const note = n === 0 ? ' _(repeat pairings are now allowed immediately)_' : '';
  await respond(`✅ Avoid repeat rounds updated to *${n}*.${note}`);
}

async function setCadence(value, respond) {
  const VALID = ['weekly', 'biweekly', 'triweekly', 'monthly'];
  const normalised = (value || '').toLowerCase();
  if (!VALID.includes(normalised)) {
    await respond(`❌ Cadence must be one of: ${VALID.map((v) => `\`${v}\``).join(', ')}.\nExample: \`/watercooler admin set cadence triweekly\``);
    return;
  }
  updateSettings({ cadence: normalised });
  await respond(`✅ Cadence updated to *${normalised}*. Scheduling will use this on the next cycle.`);
}

async function setChannel(value, respond) {
  if (!value) {
    await respond(
      '❌ Please provide a channel ID.\n' +
      'Example: `/watercooler admin set channel C01ABC123`\n' +
      '_Tip: use the channel ID (starts with C) rather than the name for reliability._'
    );
    return;
  }
  updateSettings({ intro_channel_id: value });
  await respond(`✅ Intro channel set to *${value}*.\n_This channel will be used for scheduled announcements (Phase 8)._`);
}

// ── Scheduler settings ────────────────────────────────────────────────────────

const VALID_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

async function setIntroDay(value, respond) {
  const normalised = (value || '').toLowerCase().trim();
  if (!VALID_DAYS.includes(normalised)) {
    await respond(
      `❌ Intro day must be one of: ${VALID_DAYS.map((d) => `\`${d}\``).join(', ')}.\n` +
      `Example: \`/watercooler admin set intro-day monday\``
    );
    return;
  }
  updateSettings({ intro_day: normalised });
  await respond(`✅ Intro day updated to *${normalised}*. The scheduler will use this on the next cycle.`);
}

async function setIntroTime(value, respond) {
  // Accept H:MM or HH:MM (24-hour)
  const match = (value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    await respond(
      '❌ Intro time must be in `HH:MM` format (24-hour).\n' +
      'Example: `/watercooler admin set intro-time 09:00`'
    );
    return;
  }
  const hour   = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    await respond(
      '❌ Time out of range — use `00:00` to `23:59`.\n' +
      'Example: `/watercooler admin set intro-time 14:30`'
    );
    return;
  }
  const normalised = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  updateSettings({ intro_time: normalised });
  await respond(`✅ Intro time updated to *${normalised}*. The scheduler will use this on the next cycle.`);
}

// ── Calendar settings ─────────────────────────────────────────────────────────

async function setCalendarEnabled(value, respond) {
  const normalised = (value || '').toLowerCase().trim();
  if (normalised !== 'true' && normalised !== 'false') {
    await respond(
      '❌ `calendar-enabled` must be `true` or `false`.\n' +
      'Example: `/watercooler admin set calendar-enabled true`'
    );
    return;
  }
  const flag = normalised === 'true' ? 1 : 0;
  updateSettings({ calendar_enabled: flag });
  const msg = flag
    ? '✅ Calendar integration *enabled*. Matches will offer meeting time suggestions once Azure credentials are configured.'
    : '✅ Calendar integration *disabled*. Matches will send the standard intro DM only.';
  await respond(msg);
}

async function setMeetingDuration(value, respond) {
  const VALID = [15, 30, 45, 60];
  const n = parseInt(value, 10);
  if (!VALID.includes(n)) {
    await respond(
      `❌ \`meeting-duration\` must be one of: ${VALID.map((v) => `\`${v}\``).join(', ')} (minutes).\n` +
      'Example: `/watercooler admin set meeting-duration 30`'
    );
    return;
  }
  updateSettings({ meeting_duration: n });
  await respond(`✅ Meeting duration updated to *${n} minutes*.`);
}

async function setBookingDeadline(value, respond) {
  const n = parseFloat(value);
  if (isNaN(n) || n < 0.5) {
    await respond(
      '❌ `booking-deadline` must be a number ≥ 0.5 (days before the intro DM to auto-book).\n' +
      'Example: `/watercooler admin set booking-deadline 2.5`  _(2.5 days = 60 hours)_'
    );
    return;
  }
  updateSettings({ booking_deadline: n });
  const hours = Math.floor(n) * 24 + (n % 1) * 8;
  await respond(
    `✅ Booking deadline updated to *${n} day${n === 1 ? '' : 's'}* _(${hours} hours)_ before the intro DM.\n` +
    '_If no time is chosen by then, a slot will be auto-booked._'
  );
}

async function setCalendarTimezone(value, respond) {
  const tz = (value || '').trim();
  if (!tz) {
    await respond(
      '❌ Please provide an IANA timezone.\n' +
      'Example: `/watercooler admin set calendar-timezone America/Chicago`\n' +
      '_Common values: `America/New_York`, `America/Chicago`, `America/Denver`, `America/Los_Angeles`, `UTC`_'
    );
    return;
  }
  // Validate using the built-in Intl API — throws RangeError for unknown timezones
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch (_) {
    await respond(
      `❌ \`${tz}\` is not a recognised IANA timezone.\n` +
      'Examples: `America/New_York`, `America/Chicago`, `America/Los_Angeles`, `Europe/London`, `UTC`'
    );
    return;
  }
  updateSettings({ calendar_timezone: tz });
  await respond(`✅ Calendar timezone updated to *${tz}*. Meeting times will display in this timezone.`);
}

async function setCompletionFallbackDays(value, respond) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1) {
    await respond(
      '❌ `completion-fallback-days` must be a whole number ≥ 1.\n' +
      'Example: `/watercooler admin set completion-fallback-days 12`\n' +
      '_12 business days = 2.5 business weeks (e.g. Monday round → fallback fires Wednesday 2 weeks later)_'
    );
    return;
  }
  updateSettings({ completion_fallback_days: n });
  await respond(
    `✅ Completion fallback updated to *${n} business day${n === 1 ? '' : 's'}*.\n` +
    '_Matches with no calendar booking will receive the post-meeting message after this many business days._'
  );
}

// ── Enrollment settings ───────────────────────────────────────────────────────

async function setEnrollment(value, respond) {
  const normalised = (value || '').toLowerCase().trim();
  if (normalised !== 'manual' && normalised !== 'channel') {
    await respond(
      '❌ `enrollment` must be `manual` or `channel`.\n' +
      '• `manual` — people join only via `/watercooler join`\n' +
      '• `channel` — joining the intro channel enrolls them automatically\n' +
      'Example: `/watercooler admin set enrollment channel`'
    );
    return;
  }

  // Channel mode is meaningless without a channel to watch — block it.
  if (normalised === 'channel' && !getSettings().intro_channel_id) {
    await respond(
      '❌ Can\'t enable channel enrollment — no intro channel is set.\n' +
      'Set one first: `/watercooler admin set channel <channel-id>`, then re-run this.'
    );
    return;
  }

  updateSettings({ enrollment_mode: normalised });
  const msg = normalised === 'channel'
    ? '✅ Enrollment mode set to *channel*. Joining the intro channel now enrolls people automatically; leaving opts them out.'
    : '✅ Enrollment mode set to *manual*. People join only via `/watercooler join` — channel join/leave events are ignored.';
  await respond(msg);
}

module.exports = set;
