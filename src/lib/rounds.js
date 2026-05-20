'use strict';

// DB helper functions for matching-related data reads and writes.
//
// Reads (used by dry-run and real run):
//   getEligibleUsers()           — who can be matched right now
//   getSettings()                — app-wide config (group size, cadence, etc.)
//   getRecentPairHistory(n)      — recent pairings to avoid repeats
//
// Writes (used by real run — added in Phase 6):
//   createRound(createdBy)       — start a new round record
//   saveMatch(roundId, userIds)  — record one match group
//   savePairHistory(...)         — record each pair for future repeat-avoidance
//   completeRound(roundId)       — mark the round as done
//   isRoundInProgress()          — duplicate-prevention guard

const { getDb } = require('../db/connection');

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Returns all users eligible for matching right now:
 *   - is_active  = 1  (haven't left)
 *   - is_paused  = 0  (not temporarily sitting out)
 *   - not in exclusions table (not admin-excluded)
 */
function getEligibleUsers() {
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

/**
 * Returns the single app-wide settings row.
 * Always exists — seeded by initDb() on first run.
 */
function getSettings() {
  return getDb()
    .prepare('SELECT * FROM settings LIMIT 1')
    .get();
}

/**
 * Returns pair history from the last `n` completed rounds.
 * Passed directly to the matching engine so it can avoid recent repeats.
 *
 * Returns: [{ userAId, userBId, roundId }, ...]
 *
 * Only 'completed' rounds count — dry_run rounds are never persisted,
 * so they don't affect future matching.
 */
function getRecentPairHistory(n) {
  return getDb()
    .prepare(`
      SELECT
        ph.user_a_id AS userAId,
        ph.user_b_id AS userBId,
        ph.round_id  AS roundId
      FROM pair_history ph
      WHERE ph.round_id IN (
        SELECT id
        FROM   rounds
        WHERE  status = 'completed'
        ORDER  BY id DESC
        LIMIT  ?
      )
    `)
    .all(n);
}

// ── Writes (Phase 6) ──────────────────────────────────────────────────────────

/**
 * Returns true if there is already a round with status 'pending'.
 * Used to prevent accidentally running two rounds at the same time.
 */
function isRoundInProgress() {
  const row = getDb()
    .prepare(`SELECT id FROM rounds WHERE status = 'pending' LIMIT 1`)
    .get();
  return !!row;
}

/**
 * Creates a new round row with status 'pending' and returns its id.
 */
function createRound(createdBy) {
  const result = getDb()
    .prepare(`
      INSERT INTO rounds (status, started_at, created_by)
      VALUES ('pending', datetime('now'), ?)
    `)
    .run(createdBy);
  return result.lastInsertRowid;
}

/**
 * Records one match group (pair or trio) and returns the match id.
 */
function saveMatch(roundId) {
  const result = getDb()
    .prepare(`INSERT INTO matches (round_id) VALUES (?)`)
    .run(roundId);
  return result.lastInsertRowid;
}

/**
 * Records the members of a match.
 */
function saveMatchMembers(matchId, userIds) {
  const stmt = getDb().prepare(`INSERT INTO match_members (match_id, user_id) VALUES (?, ?)`);
  for (const userId of userIds) {
    stmt.run(matchId, userId);
  }
}

/**
 * Records every pair within a group into pair_history.
 * Always stores user_a_id < user_b_id (canonical order for deduplication).
 */
function savePairHistory(roundId, users) {
  const stmt = getDb().prepare(`
    INSERT INTO pair_history (user_a_id, user_b_id, round_id)
    VALUES (?, ?, ?)
  `);

  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      const [a, b] = [users[i].id, users[j].id].sort((x, y) => x - y);
      stmt.run(a, b, roundId);
    }
  }
}

/**
 * Marks a round as completed and records the completion time.
 */
function completeRound(roundId) {
  getDb()
    .prepare(`
      UPDATE rounds
      SET status = 'completed', completed_at = datetime('now')
      WHERE id = ?
    `)
    .run(roundId);
}

/**
 * Saves the Slack DM channel ID back onto a match row (after the DM is created).
 */
function updateMatchChannel(matchId, slackDmChannelId) {
  getDb()
    .prepare(`UPDATE matches SET slack_dm_channel_id = ? WHERE id = ?`)
    .run(slackDmChannelId, matchId);
}

module.exports = {
  getEligibleUsers,
  getSettings,
  getRecentPairHistory,
  isRoundInProgress,
  createRound,
  saveMatch,
  saveMatchMembers,
  savePairHistory,
  completeRound,
  updateMatchChannel,
};
