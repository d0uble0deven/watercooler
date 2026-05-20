require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),

  // Slack credentials
  slackBotToken: process.env.SLACK_BOT_TOKEN,
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
  slackAppToken: process.env.SLACK_APP_TOKEN,

  // Comma-separated Slack user IDs that can run admin commands
  // e.g. ADMIN_USER_IDS=U01ABC123,U02DEF456
  adminUserIds: (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),

  // SQLite database path (used starting Phase 2)
  databasePath: process.env.DATABASE_PATH || './data/watercooler.db',

  // Scheduling (used in Phase 8)
  schedulingEnabled: process.env.SCHEDULING_ENABLED === 'true',
};

// True only when all three Slack secrets are present.
// The app starts without them; Slack commands just won't work until they're set.
config.hasSlackCredentials = !!(
  config.slackBotToken &&
  config.slackSigningSecret &&
  config.slackAppToken
);

module.exports = config;
