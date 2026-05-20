const express    = require('express');
const config     = require('./config');
const { initDb } = require('./db/init');

async function start() {
  // ── Database ──────────────────────────────────────────────────────────────
  // Creates tables on first run; safe (idempotent) on every subsequent run.
  initDb();

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

  const app = new App({
    token: config.slackBotToken,
    signingSecret: config.slackSigningSecret,
    socketMode: true,   // no public URL needed — connects via WebSocket to Slack
    appToken: config.slackAppToken,
  });

  // Register all /watercooler subcommands (join, pause, resume, leave, status, …)
  registerCommands(app);

  await app.start();
  console.log('⚡️ Slack Bolt connected via Socket Mode\n');
}

start().catch((err) => {
  console.error('❌ Watercooler failed to start:', err.message);
  process.exit(1);
});
