const express    = require('express');
const config     = require('./config');
const { initDb }              = require('./db/init');
const { cancelStuckRounds }   = require('./lib/rounds');

async function start() {
  // ── Database ──────────────────────────────────────────────────────────────
  // Creates tables on first run; safe (idempotent) on every subsequent run.
  initDb();

  // Cancel any rounds left stuck as 'pending' from a previous crash.
  // Without this, isRoundInProgress() would block all future runs forever.
  const stuckCount = cancelStuckRounds();
  if (stuckCount > 0) {
    console.warn(`⚠️  Cancelled ${stuckCount} stuck round(s) from a previous crash.`);
  }

  // ── Startup validation ────────────────────────────────────────────────────
  if (config.adminUserIds.length === 0) {
    console.warn('⚠️  ADMIN_USER_IDS is not set — nobody can run admin commands.');
    console.warn('   Add your Slack user ID to .env: ADMIN_USER_IDS=U01XXXXXXX');
  }

  // ── Express server ────────────────────────────────────────────────────────
  // Always starts, regardless of Slack credentials.
  // Powers GET /health and will serve any future HTTP routes.
  const expressApp = express();
  expressApp.use(express.json());

  expressApp.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      slack_connected: config.hasSlackCredentials,
      timestamp: new Date().toISOString(),
    });
  });

  const server = expressApp.listen(config.port, () => {
    console.log(`\n🚀 Watercooler running on http://localhost:${config.port}`);
    console.log(`   Health check → http://localhost:${config.port}/health\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${config.port} is already in use.`);
      console.error(`   Either stop the process using it, or set a different PORT= in your .env\n`);
    } else {
      console.error('❌ Server error:', err.message);
    }
    process.exit(1);
  });

  // ── Slack Bolt ────────────────────────────────────────────────────────────
  // Only starts when all three Slack tokens are present in .env.
  // If tokens are missing, the server still starts — Slack just won't connect.
  if (!config.hasSlackCredentials) {
    console.log('⚠️  Slack credentials not found — running in Express-only mode.');
    console.log('   To enable Slack: copy .env.example → .env and fill in your tokens.\n');
    return;
  }

  const { App }              = require('@slack/bolt');
  const { registerCommands } = require('./commands/index');
  const { startScheduler }   = require('./scheduler/index');

  const app = new App({
    token: config.slackBotToken,
    signingSecret: config.slackSigningSecret,
    socketMode: true,   // no public URL needed — connects via WebSocket to Slack
    appToken: config.slackAppToken,
  });

  // Register all /watercooler subcommands (join, pause, resume, leave, status, …)
  registerCommands(app);

  // ── Calendar slot booking buttons (Phase 10 Step 6) ────────────────────
  // Handles clicks on the time-slot buttons posted in match DMs.
  // Parses the button value, creates a calendar invite + Teams link via Graph,
  // then replaces the buttons with a booking confirmation.
  const { handleBookSlot } = require('./commands/actions/bookSlot');
  app.action(/^watercooler_book_slot_\d+$/, handleBookSlot);

  // "Join Teams Meeting" link buttons just need an ack — Slack opens the URL
  // directly in the browser; no server-side logic required.
  app.action('watercooler_join_teams', async ({ ack }) => { await ack(); });

  // Post-meeting feedback buttons (Phase 11 Step 4)
  const { handleMeetingGood, handleMeetingMeh, handleMeetingSnooze } =
    require('./commands/actions/meetingFeedback');
  app.action('watercooler_meeting_good',   handleMeetingGood);
  app.action('watercooler_meeting_meh',    handleMeetingMeh);
  app.action('watercooler_meeting_snooze', handleMeetingSnooze);

  await app.start();
  console.log('⚡️ Slack Bolt connected via Socket Mode\n');

  // Start the scheduler (no-op if SCHEDULING_ENABLED != true)
  startScheduler(app);

  // ── Graceful shutdown ────────────────────────────────────────────────────
  // Give in-flight Slack API calls a moment to finish before the process exits.
  // Without this, a SIGTERM mid-run could orphan a 'pending' round (caught by
  // cancelStuckRounds() on the next startup, but cleaner to avoid entirely).
  const shutdown = (signal) => {
    console.log(`\n[Watercooler] ${signal} received — shutting down gracefully…`);
    server.close(() => {
      console.log('[Watercooler] HTTP server closed. Goodbye.\n');
      process.exit(0);
    });
    // Force-exit after 10 s if the server hasn't drained by then.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('❌ Watercooler failed to start:', err.message);
  process.exit(1);
});
