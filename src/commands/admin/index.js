'use strict';

// Admin command router.
//
// All admin commands go through here. The admin guard is checked ONCE at the
// top — individual handlers don't need to repeat the check.
//
// Phase 5:  dry-run
// Phase 6:  run
// Phase 7:  summary, participants, paused, settings, recent-rounds, set, exclude, include

const { isAdmin } = require('../../lib/adminGuard');
const dryRun      = require('./dry-run');

const ADMIN_HELP = `*Watercooler admin commands:*
• \`/watercooler admin dry-run\` — preview matches without sending DMs
• \`/watercooler admin run\` — run matching and send intro DMs _(Phase 6)_
• \`/watercooler admin summary\` — participant counts at a glance _(Phase 7)_
• \`/watercooler admin participants\` — list active participants _(Phase 7)_
• \`/watercooler admin paused\` — list paused participants _(Phase 7)_
• \`/watercooler admin settings\` — show current settings _(Phase 7)_
• \`/watercooler admin recent-rounds\` — last few match rounds _(Phase 7)_
• \`/watercooler admin set group-size <n>\` _(Phase 7)_
• \`/watercooler admin set avoid-repeat-rounds <n>\` _(Phase 7)_
• \`/watercooler admin set cadence weekly|biweekly|monthly\` _(Phase 7)_
• \`/watercooler admin exclude @user\` _(Phase 7)_
• \`/watercooler admin include @user\` _(Phase 7)_`;

async function handleAdmin(command, text, respond) {
  // Admin guard — one check covers all sub-commands
  if (!isAdmin(command.user_id)) {
    await respond(
      '⛔ This command is for Watercooler admins only.\n' +
      'Ask an admin if you need help, or use `/watercooler join` to participate.'
    );
    return;
  }

  const [subcommand = ''] = (text || '').trim().toLowerCase().split(/\s+/);

  try {
    switch (subcommand) {

      case 'dry-run':
        return await dryRun(command, respond);

      // ── Phase 6 stubs ──────────────────────────────────────────────────────
      case 'run':
        return await respond(
          '`/watercooler admin run` is coming in Phase 6.\n' +
          'Use `/watercooler admin dry-run` to preview matches in the meantime.'
        );

      // ── Phase 7 stubs ──────────────────────────────────────────────────────
      case 'summary':
      case 'participants':
      case 'paused':
      case 'settings':
      case 'recent-rounds':
      case 'set':
      case 'exclude':
      case 'include':
        return await respond(`\`/watercooler admin ${subcommand}\` is coming in Phase 7.`);

      default:
        return await respond(ADMIN_HELP);
    }
  } catch (err) {
    console.error(`[/watercooler admin ${subcommand}] Unhandled error:`, err);
    await respond('⚠️ Something went wrong on our end. Check the server logs.');
  }
}

module.exports = { handleAdmin };
