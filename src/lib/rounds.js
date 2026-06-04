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
 * Returns completion stats for the most recently completed round, excluding
 * the round that was just created (so a fresh run always shows the previous
 * round's numbers, not its own zeroed-out data).
 *
 * "Met" = total matches minus those who clicked Snooze. Matches with no
 * feedback response (user ignored the buttons) are counted as met — same
 * assumption Donut uses.
 *
 * Returns null when there is no eligible previous round.
 *
 * @param {number} excludeRoundId  The current round ID to exclude
 * @returns {{ roundId, total, met, snoozed, pct } | null}
 */
function getLastRoundStats(excludeRoundId) {
  const db = getDb();

  const round = db.prepare(`
    SELECT id FROM rounds
    WHERE  status = 'completed'
      AND  id != ?
    ORDER  BY id DESC
    LIMIT  1
  `).get(excludeRoundId ?? 0);

  if (!round) return null;

  const row = db.prepare(`
    SELECT
      COUNT(*)                                              AS total,
      SUM(CASE WHEN feedback = 'snoozed' THEN 1 ELSE 0 END) AS snoozed
    FROM matches
    WHERE round_id = ?
  `).get(round.id);

  if (!row || row.total === 0) return null;

  const met = row.total - (row.snoozed ?? 0);
  const pct = Math.round((met / row.total) * 100);

  return { roundId: round.id, total: row.total, met, snoozed: row.snoozed ?? 0, pct };
}

/**
 * Saves the Slack DM channel ID back onto a match row (after the DM is created).
 */
function updateMatchChannel(matchId, slackDmChannelId) {
  getDb()
    .prepare(`UPDATE matches SET slack_dm_channel_id = ? WHERE id = ?`)
    .run(slackDmChannelId, matchId);
}

// ── Admin reads ───────────────────────────────────────────────────────────────

/**
 * Returns the last `limit` completed rounds with group and participant counts.
 * Used by the `recent-rounds` admin command.
 */
function getRecentRounds(limit = 5) {
  return getDb()
    .prepare(`
      SELECT
        r.id,
        r.started_at,
        r.completed_at,
        r.created_by,
        COUNT(DISTINCT m.id)  AS match_count,
        COUNT(mm.id)          AS participant_count
      FROM   rounds r
      LEFT JOIN matches      m  ON m.round_id  = r.id
      LEFT JOIN match_members mm ON mm.match_id = m.id
      WHERE  r.status = 'completed'
      GROUP  BY r.id
      ORDER  BY r.id DESC
      LIMIT  ?
    `)
    .all(limit);
}

/**
 * Returns participant counts used by the `summary` admin command.
 */
function getParticipantCounts() {
  const db = getDb();
  return {
    eligible: db.prepare(`
      SELECT COUNT(*) AS n FROM users
      WHERE is_active = 1 AND is_paused = 0
        AND slack_user_id NOT IN (SELECT slack_user_id FROM exclusions)
    `).get().n,
    paused:          db.prepare(`SELECT COUNT(*) AS n FROM users WHERE is_active = 1 AND is_paused = 1`).get().n,
    excluded:        db.prepare(`SELECT COUNT(*) AS n FROM exclusions`).get().n,
    totalActive:     db.prepare(`SELECT COUNT(*) AS n FROM users WHERE is_active = 1`).get().n,
    completedRounds: db.prepare(`SELECT COUNT(*) AS n FROM rounds WHERE status = 'completed'`).get().n,
    lastRoundDate:   db.prepare(`SELECT started_at FROM rounds WHERE status = 'completed' ORDER BY id DESC LIMIT 1`).get()?.started_at ?? null,
  };
}

// ── Calendar booking ──────────────────────────────────────────────────────────

/**
 * Returns the full match row by ID (includes calendar_event_id if already booked).
 */
function getMatch(matchId) {
  return getDb()
    .prepare(`SELECT * FROM matches WHERE id = ?`)
    .get(matchId);
}

/**
 * Returns all user rows for a given match (via the match_members join).
 * Used by the booking handler to build the attendee list.
 */
function getMatchUsers(matchId) {
  return getDb()
    .prepare(`
      SELECT u.*
      FROM   users u
      JOIN   match_members mm ON mm.user_id = u.id
      WHERE  mm.match_id = ?
      ORDER  BY u.display_name
    `)
    .all(matchId);
}

/**
 * Saves the Slack message timestamp of the calendar-suggestion message.
 * Stored so the auto-booker can update the original message in-place rather
 * than posting a new one.
 */
function saveSuggestionTs(matchId, ts) {
  getDb()
    .prepare(`UPDATE matches SET calendar_suggestion_ts = ? WHERE id = ?`)
    .run(ts, matchId);
}

/**
 * Returns all matches with completion_message_sent = 0 from completed rounds,
 * with no time filter. Used by the `send-completion` admin command to bypass
 * the normal meeting-time / fallback-days gate.
 */
function getAllMatchesPendingCompletion() {
  return getDb().prepare(`
    SELECT m.*
    FROM   matches m
    JOIN   rounds r ON r.id = m.round_id
    WHERE  m.completion_message_sent = 0
      AND  m.slack_dm_channel_id    IS NOT NULL
      AND  r.status = 'completed'
    ORDER  BY m.id ASC
  `).all();
}

/**
 * Returns true when every match in the given round has completion_message_sent = 1.
 * Used to decide whether to post the round-summary to the intro channel.
 */
function isRoundFullyComplete(roundId) {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS total, SUM(completion_message_sent) AS sent
    FROM   matches WHERE round_id = ?
  `).get(roundId);
  return row && row.total > 0 && row.sent >= row.total;
}

/**
 * Marks the round's channel summary as sent so it is never posted twice.
 */
function markRoundSummarySent(roundId) {
  getDb()
    .prepare(`UPDATE rounds SET summary_sent = 1 WHERE id = ?`)
    .run(roundId);
}

/**
 * Returns the number of matches in a round. Used for the channel summary message.
 */
function getRoundMatchCount(roundId) {
  return getDb()
    .prepare(`SELECT COUNT(*) AS n FROM matches WHERE round_id = ?`)
    .get(roundId).n;
}

/**
 * Returns a single round by ID.
 */
function getRoundById(roundId) {
  return getDb()
    .prepare(`SELECT * FROM rounds WHERE id = ?`)
    .get(roundId);
}

/**
 * Returns the most recent round that is not already cancelled.
 * Used by `cancel-round` when no roundId is provided.
 */
function getMostRecentActiveRound() {
  return getDb()
    .prepare(`SELECT * FROM rounds WHERE status != 'cancelled' ORDER BY id DESC LIMIT 1`)
    .get();
}

/**
 * Returns all matches for a given round, including calendar booking state.
 * Used by `cancel-round` to find what needs to be cleaned up.
 */
function getMatchesForRound(roundId) {
  return getDb()
    .prepare(`SELECT * FROM matches WHERE round_id = ? ORDER BY id ASC`)
    .all(roundId);
}

/**
 * Marks a round as cancelled. Safe to call on any status.
 */
function markRoundCancelled(roundId) {
  getDb()
    .prepare(`UPDATE rounds SET status = 'cancelled', completed_at = datetime('now') WHERE id = ?`)
    .run(roundId);
}

/**
 * Returns every unbooked match from a completed round, regardless of age.
 * Used by the `force-book` admin command to bypass the deadline filter.
 */
function getAllUnbookedMatches() {
  return getDb().prepare(`
    SELECT m.*
    FROM   matches m
    JOIN   rounds r ON r.id = m.round_id
    WHERE  m.calendar_event_id   IS NULL
      AND  m.slack_dm_channel_id IS NOT NULL
      AND  r.status = 'completed'
    ORDER  BY m.id ASC
  `).all();
}

/**
 * Returns all unbooked matches whose parent round completed more than
 * `deadlineHours` ago. These are candidates for auto-booking.
 *
 * Only includes matches that:
 *   - Have a DM channel (so we can post to them)
 *   - Are NOT already booked
 *   - Belong to a completed round older than the deadline
 */
function getUnbookedMatchesPastDeadline(deadlineHours) {
  const cutoff = new Date(Date.now() - deadlineHours * 60 * 60 * 1000).toISOString();
  return getDb()
    .prepare(`
      SELECT m.*
      FROM   matches m
      JOIN   rounds r ON r.id = m.round_id
      WHERE  m.calendar_event_id    IS NULL
        AND  m.slack_dm_channel_id  IS NOT NULL
        AND  r.status = 'completed'
        AND  r.completed_at < ?
    `)
    .all(cutoff);
}

/**
 * Persists the calendar event ID, Teams link, and booking timestamp on a match row.
 * Called immediately after the Graph API event is created.
 */
function saveBooking(matchId, { calendarEventId, teamsLink }) {
  getDb()
    .prepare(`
      UPDATE matches
      SET calendar_event_id = ?,
          teams_link         = ?,
          booked_at          = datetime('now')
      WHERE id = ?
    `)
    .run(calendarEventId ?? null, teamsLink ?? null, matchId);
}

/**
 * Atomically claims the booking slot for a match by writing a 'pending'
 * sentinel to calendar_event_id ONLY if it is currently NULL.
 *
 * Returns true if this caller won the claim, false if another request already
 * claimed or booked the match. Because node:sqlite runs synchronously on the
 * Node event loop, the UPDATE is atomic — no two concurrent await-gaps can
 * both see IS NULL and both win.
 */
function claimBooking(matchId) {
  const result = getDb()
    .prepare(`UPDATE matches SET calendar_event_id = 'pending' WHERE id = ? AND calendar_event_id IS NULL`)
    .run(matchId);
  return result.changes > 0;
}

/**
 * Releases a 'pending' booking claim back to NULL so the slot can be retried.
 * Only clears the sentinel — never touches a real event ID.
 */
function releaseBookingClaim(matchId) {
  getDb()
    .prepare(`UPDATE matches SET calendar_event_id = NULL WHERE id = ? AND calendar_event_id = 'pending'`)
    .run(matchId);
}

/**
 * Stores a participant's feedback response on a match row.
 * @param {number} matchId
 * @param {'good'|'meh'|'snoozed'} feedback
 */
function saveFeedback(matchId, feedback) {
  getDb()
    .prepare(`UPDATE matches SET feedback = ? WHERE id = ?`)
    .run(feedback, matchId);
}

/**
 * Marks the completion message as sent on a match row so the scheduler
 * never sends it a second time.
 */
function markCompletionMessageSent(matchId) {
  getDb()
    .prepare(`UPDATE matches SET completion_message_sent = 1 WHERE id = ?`)
    .run(matchId);
}

/**
 * Stores the actual meeting start and end times on a match row.
 * Called right after saveBooking() — used later by the completion checker
 * to know when the meeting has passed and the post-meeting message should fire.
 *
 * @param {number} matchId
 * @param {Date}   start   Meeting start (UTC)
 * @param {Date}   end     Meeting end   (UTC)
 */
function saveMeetingTimes(matchId, start, end) {
  getDb()
    .prepare(`
      UPDATE matches
      SET meeting_start_at = ?,
          meeting_end_at   = ?
      WHERE id = ?
    `)
    .run(start.toISOString(), end.toISOString(), matchId);
}

/**
 * Returns the last `numRounds` rounds (any status) with their matches and
 * participant names. Used by the `list-matches` admin command.
 *
 * @param {number} numRounds
 * @returns {{ rounds: object[], matches: object[] }}
 */
function getRecentMatchesForAdmin(numRounds = 2) {
  const db = getDb();

  const rounds = db.prepare(
    `SELECT * FROM rounds ORDER BY id DESC LIMIT ?`
  ).all(numRounds);

  if (rounds.length === 0) return { rounds: [], matches: [] };

  const ids          = rounds.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const matches = db.prepare(`
    SELECT
      m.id,
      m.round_id,
      m.booked_at,
      m.completion_message_sent,
      m.calendar_suggestion_ts,
      m.meeting_start_at,
      m.calendar_event_id,
      m.slack_dm_channel_id,
      GROUP_CONCAT(u.display_name, ' & ') AS participants
    FROM   matches m
    LEFT JOIN match_members mm ON mm.match_id = m.id
    LEFT JOIN users         u  ON u.id = mm.user_id
    WHERE  m.round_id IN (${placeholders})
    GROUP  BY m.id
    ORDER  BY m.round_id DESC, m.id ASC
  `).all(...ids);

  return { rounds, matches };
}

// ── Settings write ────────────────────────────────────────────────────────────

/**
 * Updates specific fields in the single settings row and returns the updated row.
 * fields: plain object e.g. { group_size: 3 } or { cadence: 'biweekly' }
 */
function updateSettings(fields) {
  const setClauses = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  const values     = [...Object.values(fields), new Date().toISOString()];

  getDb()
    .prepare(`UPDATE settings SET ${setClauses}, updated_at = ? WHERE id = 1`)
    .run(...values);

  return getSettings();
}

/**
 * On startup: cancels any rounds that have been stuck as 'pending' for
 * longer than 1 hour. These are almost certainly orphaned by a crash.
 *
 * Without this, a single crash would permanently block all future runs
 * (isRoundInProgress() would always return true).
 *
 * Returns the number of rounds cancelled.
 */
function cancelStuckRounds() {
  const result = getDb()
    .prepare(`
      UPDATE rounds
      SET    status = 'cancelled', completed_at = datetime('now')
      WHERE  status = 'pending'
        AND  datetime(started_at, '+1 hour') < datetime('now')
    `)
    .run();
  return result.changes;
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
  getLastRoundStats,
  getRecentRounds,
  getParticipantCounts,
  updateSettings,
  cancelStuckRounds,
  getMatch,
  getMatchUsers,
  saveBooking,
  claimBooking,
  releaseBookingClaim,
  saveMeetingTimes,
  saveFeedback,
  markCompletionMessageSent,
  saveSuggestionTs,
  getUnbookedMatchesPastDeadline,
  getRoundById,
  getMostRecentActiveRound,
  getMatchesForRound,
  markRoundCancelled,
  getAllUnbookedMatches,
  getAllMatchesPendingCompletion,
  isRoundFullyComplete,
  markRoundSummarySent,
  getRoundMatchCount,
  getRecentMatchesForAdmin,
};
