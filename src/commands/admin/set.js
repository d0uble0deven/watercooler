'use strict';

// Handles: /watercooler admin set <setting> <value>
//
// Supported settings:
//   set group-size <n>              — n must be >= 2
//   set avoid-repeat-rounds <n>     — n must be >= 0
//   set cadence weekly|biweekly|monthly
//   set channel <channel-id>        — use a Slack channel ID (C...) for reliability
//   set intro-day <day-name>        — day of week the scheduler fires
//   set intro-time <HH:MM>          — time of day the scheduler fires (24-hour)

const { updateSettings } = require('../../lib/rounds');

const SET_HELP = [
  '*Available settings:*',
  '• `/watercooler admin set group-size <n>` — pair size (must be ≥ 2)',
  '• `/watercooler admin set avoid-repeat-rounds <n>` — repeat-avoidance window (0 = off)',
  '• `/watercooler admin set cadence weekly|biweekly|monthly`',
  '• `/watercooler admin set channel <channel-id>` — channel for automated announcements',
  '• `/watercooler admin set intro-day <day>` — day the scheduler fires (e.g. `monday`)',
  '• `/watercooler admin set intro-time <HH:MM>` — time the scheduler fires (24-hour)',
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
  const VALID = ['weekly', 'biweekly', 'monthly'];
  const normalised = (value || '').toLowerCase();
  if (!VALID.includes(normalised)) {
    await respond(`❌ Cadence must be one of: ${VALID.map((v) => `\`${v}\``).join(', ')}.\nExample: \`/watercooler admin set cadence weekly\``);
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

module.exports = set;
