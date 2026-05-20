'use strict';

// Admin access is controlled entirely by environment variable.
// Set ADMIN_USER_IDS in .env as a comma-separated list of Slack user IDs.
// Example: ADMIN_USER_IDS=U01ABC123,U02DEF456
//
// To find your Slack user ID: open your Slack profile → ⋮ menu → "Copy member ID"

const config = require('../config');

function isAdmin(slackUserId) {
  return config.adminUserIds.includes(slackUserId);
}

module.exports = { isAdmin };
