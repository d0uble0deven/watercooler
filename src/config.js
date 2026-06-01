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

  // Scheduling (Phase 8)
  schedulingEnabled: process.env.SCHEDULING_ENABLED === 'true',

  // Microsoft Graph / Outlook calendar integration (Phase 10+)
  // Credentials provided by IT after Azure AD app registration.
  // See docs/OUTLOOK_INTEGRATION.md for setup instructions.
  azureTenantId:     process.env.AZURE_TENANT_ID     || null,
  azureClientId:     process.env.AZURE_CLIENT_ID     || null,
  azureClientSecret: process.env.AZURE_CLIENT_SECRET || null,
  calendarEnabled:   process.env.CALENDAR_ENABLED === 'true',

  // IANA timezone used when displaying suggested meeting times to users.
  // Must be a valid Intl timezone string (e.g. 'America/New_York', 'America/Chicago').
  // See: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
  calendarTimezone:  process.env.CALENDAR_TIMEZONE  || 'America/New_York',

  // Name shown in calendar invites as the person to contact for issues.
  // If blank, the contact line is omitted from the email body.
  contactName: process.env.CONTACT_NAME || '',
};

// True only when all three Slack secrets are present.
// The app starts without them; Slack commands just won't work until they're set.
config.hasSlackCredentials = !!(
  config.slackBotToken &&
  config.slackSigningSecret &&
  config.slackAppToken
);

module.exports = config;
