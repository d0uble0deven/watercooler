'use strict';

// Registers /watercooler with Slack Bolt and routes subcommands to their handlers.
//
// Routing logic:
//   /watercooler join      → commands/user/join.js
//   /watercooler pause     → commands/user/pause.js
//   /watercooler resume    → commands/user/resume.js
//   /watercooler leave     → commands/user/leave.js
//   /watercooler status    → commands/user/status.js
//   /watercooler admin … → commands/admin/index.js
//   /watercooler           → help text

const join                = require('./user/join');
const pause               = require('./user/pause');
const resume              = require('./user/resume');
const leave               = require('./user/leave');
const status              = require('./user/status');
const { handleAdmin }     = require('./admin/index');

const HELP_TEXT = `*Watercooler commands:*
• \`/watercooler join\` — opt in to casual matching
• \`/watercooler pause\` — skip the next round (stay opted in)
• \`/watercooler resume\` — come back after pausing
• \`/watercooler leave\` — opt out entirely
• \`/watercooler status\` — check your current status`;

function registerCommands(app) {
  app.command('/watercooler', async ({ command, ack, respond }) => {
    // Always acknowledge within 3 seconds — Slack will show a timeout error if we don't.
    await ack();

    // First word after /watercooler is the subcommand. Everything else is args.
    const [subcommand = ''] = (command.text || '').trim().toLowerCase().split(/\s+/);

    try {
      switch (subcommand) {
        case 'join':   return await join(command, respond);
        case 'pause':  return await pause(command, respond);
        case 'resume': return await resume(command, respond);
        case 'leave':  return await leave(command, respond);
        case 'status': return await status(command, respond);

        // Admin subcommands — everything after "admin" is forwarded as text
        case 'admin': {
          const adminText = (command.text || '').replace(/^admin\s*/i, '').trim();
          return await handleAdmin(command, adminText, respond);
        }

        default:
          return await respond(HELP_TEXT);
      }
    } catch (err) {
      console.error(`[/watercooler ${subcommand}] Unhandled error:`, err);
      await respond('⚠️ Something went wrong on our end. Please try again in a moment.');
    }
  });
}

module.exports = { registerCommands };
