'use strict';

// DB helper functions for the users and exclusions tables.
// All functions are synchronous (node:sqlite is synchronous by design).
// Command handlers call these instead of writing SQL directly.

const { getDb } = require('../db/connection');

// ── Reads ─────────────────────────────────────────────────────────────────────

// Returns the full user row, or undefined if they've never joined.
function getUserBySlackId(slackUserId) {
  return getDb()
    .prepare('SELECT * FROM users WHERE slack_user_id = ?')
    .get(slackUserId);
}

// Returns true if an admin has excluded this user from matching.
function isUserExcluded(slackUserId) {
  const row = getDb()
    .prepare('SELECT id FROM exclusions WHERE slack_user_id = ?')
    .get(slackUserId);
  return !!row;
}

// ── Writes ────────────────────────────────────────────────────────────────────

// Insert a new user row and return the full record.
function createUser(slackUserId, displayName) {
  getDb()
    .prepare(`
      INSERT INTO users (slack_user_id, display_name, is_active, is_paused)
      VALUES (?, ?, 1, 0)
    `)
    .run(slackUserId, displayName);

  return getUserBySlackId(slackUserId);
}

// Update specific fields on a user row.
// fields: plain object e.g. { is_active: 0 } or { is_paused: 1 }
// updated_at is always bumped automatically.
function updateUser(slackUserId, fields) {
  const setClauses = Object.keys(fields)
    .map((k) => `${k} = ?`)
    .join(', ');

  const values = [
    ...Object.values(fields),
    new Date().toISOString(), // updated_at
    slackUserId,
  ];

  getDb()
    .prepare(`UPDATE users SET ${setClauses}, updated_at = ? WHERE slack_user_id = ?`)
    .run(...values);

  return getUserBySlackId(slackUserId);
}

// ── Admin reads ───────────────────────────────────────────────────────────────

// All active, non-paused users (i.e., eligible for matching). Excludes admin-excluded users.
// Used by the `participants` admin command and as the basis for `summary`.
function getActiveUsers() {
  return getDb()
    .prepare(`
      SELECT u.*
      FROM   users u
      WHERE  u.is_active  = 1
        AND  u.is_paused  = 0
        AND  u.slack_user_id NOT IN (SELECT slack_user_id FROM exclusions)
      ORDER  BY u.display_name
    `)
    .all();
}

// All users who are active but paused.
function getPausedUsers() {
  return getDb()
    .prepare(`SELECT * FROM users WHERE is_active = 1 AND is_paused = 1 ORDER BY display_name`)
    .all();
}

// Every user row regardless of active/paused status — used by refresh-names.
function getAllUsers() {
  return getDb()
    .prepare('SELECT * FROM users ORDER BY display_name')
    .all();
}

// All admin-exclusion records.
function getExclusions() {
  return getDb()
    .prepare(`SELECT * FROM exclusions ORDER BY created_at DESC`)
    .all();
}

// ── Admin exclusion writes ────────────────────────────────────────────────────

// Add (or replace) an exclusion. Does not modify the users table.
function addExclusion(slackUserId, reason, createdBy) {
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO exclusions (slack_user_id, reason, created_by)
      VALUES (?, ?, ?)
    `)
    .run(slackUserId, reason || null, createdBy);
}

// Remove an exclusion. Returns the SQLite result ({ changes: n }).
function removeExclusion(slackUserId) {
  return getDb()
    .prepare(`DELETE FROM exclusions WHERE slack_user_id = ?`)
    .run(slackUserId);
}

// ── Calendar helpers ──────────────────────────────────────────────────────────

// Caches a user's Outlook/Microsoft email address so we don't have to query
// the Slack API on every match run. Called the first time we successfully
// retrieve the email from Slack's users.info endpoint.
function saveUserEmail(slackUserId, email) {
  getDb()
    .prepare(`UPDATE users SET slack_email = ?, updated_at = ? WHERE slack_user_id = ?`)
    .run(email, new Date().toISOString(), slackUserId);
}

module.exports = {
  getUserBySlackId,
  isUserExcluded,
  createUser,
  updateUser,
  getActiveUsers,
  getPausedUsers,
  getAllUsers,
  getExclusions,
  addExclusion,
  removeExclusion,
  saveUserEmail,
};
