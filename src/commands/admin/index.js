'use strict';

// Admin command router.
//
// All admin commands go through here. The admin guard is checked ONCE at the
// top — individual handlers don't need to repeat the check.
//
// Phase 5:  dry-run
// Phase 6:  run
// Phase 7:  summary, participants, paused, settings, recent-rounds, set, exclude, include

const { isAdmin }          = require('../../lib/adminGuard');
const dryRun               = require('./dry-run');
const run                  = require('./run');
const summary              = require('./summary');
const participants         = require('./participants');
const paused               = require('./paused');
const showSettings         = require('./show-settings');
const recentRounds         = require('./recent-rounds');
const set                  = require('./set');
const { exclude, include } = require('./exclusions');
const calendarStatus       = require('./calendar-status');

const ADMIN_HELP = `*Watercooler admin commands:*
• \`/watercooler admin dry-run\` — preview matches without sending DMs
• \`/watercooler admin run\` — run matching and send intro DMs
• \`/watercooler admin summary\` — participant counts at a glance
• \`/watercooler admin participants\` — list eligible participants
• \`/watercooler admin paused\` — list paused participants
• \`/watercooler admin settings\` — show current settings
• \`/watercooler admin recent-rounds\` — last few match rounds
• \`/watercooler admin set group-size <n>\`
• \`/watercooler admin set avoid-repeat-rounds <n>\`
• \`/watercooler admin set cadence weekly|biweekly|triweekly|monthly\`
• \`/watercooler admin set channel <channel-id>\`
• \`/watercooler admin exclude @user\` — prevent user from being matched
• \`/watercooler admin include @user\` — lift an exclusion
• \`/watercooler admin calendar-status\` — check Microsoft Graph connection`;

// `client` is Bolt's Web API client — only needed by commands that call Slack
// (currently just `run`). Read-only commands don't use it.
async function handleAdmin(command, text, respond, client) {
  // Admin guard — one check covers all sub-commands
  if (!isAdmin(command.user_id)) {
    await respond(
      '⛔ This command is for Watercooler admins only.\n' +
      'Ask an admin if you need help, or use `/watercooler join` to participate.'
    );
    return;
  }

  // Split into subcommand + remaining args.
  // e.g. "set group-size 3" → subcommand="set", args="group-size 3"
  // e.g. "exclude <@U01ABC|alice>" → subcommand="exclude", args="<@U01ABC|alice>"
  const parts = (text || '').trim().split(/\s+/);
  const subcommand = (parts[0] || '').toLowerCase();
  const args = parts.slice(1).join(' ');

  try {
    switch (subcommand) {

      case 'dry-run':
        return await dryRun(command, respond);

      case 'run':
        return await run(command, respond, client);

      case 'summary':
        return await summary(command, respond);

      case 'participants':
        return await participants(command, respond);

      case 'paused':
        return await paused(command, respond);

      case 'settings':
        return await showSettings(command, respond);

      case 'recent-rounds':
        return await recentRounds(command, respond);

      case 'set':
        return await set(command, args, respond);

      case 'exclude':
        return await exclude(command, args, respond);

      case 'include':
        return await include(command, args, respond);

      case 'calendar-status':
        return await calendarStatus(command, respond);

      default:
        return await respond(ADMIN_HELP);
    }
  } catch (err) {
    console.error(`[/watercooler admin ${subcommand}] Unhandled error:`, err);
    await respond('⚠️ Something went wrong on our end. Check the server logs.');
  }
}

module.exports = { handleAdmin };
