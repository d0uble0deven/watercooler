'use strict';

/**
 * Pure matching engine — no Slack, no DB, no side effects.
 *
 * Takes a list of eligible users and a recent pair history, and produces
 * match groups. Pair history comes from the DB (Phase 5+) but is passed
 * in as plain data so this module stays independently testable.
 *
 * @param {object[]} users
 *   Eligible users: [{ id, slack_user_id, display_name }, ...]
 *
 * @param {object[]} pairHistory
 *   Recent pairings to avoid: [{ userAId, userBId, roundId }, ...]
 *   The caller is responsible for filtering this to only the last N rounds
 *   (where N = avoidRepeatRounds setting). The engine treats any entry in
 *   this list as "recently paired — avoid if possible."
 *
 * @param {object} options
 *   { groupSize: 2 }  — only groupSize 2 (pairs) is supported for now.
 *
 * @returns {object[]}
 *   Array of match groups: [{ users: [user, user] }, { users: [user, user, user] }, ...]
 *   - Even count:  all pairs
 *   - Odd count:   all pairs + exactly one trio (the last group)
 *   - 0 or 1 users: empty array
 */
function createMatches(users, pairHistory = [], options = {}) {
  const groupSize = options.groupSize ?? 2;

  if (groupSize !== 2) {
    throw new Error(
      `groupSize ${groupSize} is not yet supported. Only groupSize 2 (pairs) is implemented.`
    );
  }

  // Nothing to match
  if (!users || users.length < 2) return [];

  // A single greedy pass can strand two recently-paired users as the last pair
  // (the algorithm is locally optimal but not globally optimal). Fix: run up to
  // MAX_ATTEMPTS shuffles, keep whichever produces the fewest repeats.
  // For teams < ~100 people this reliably finds a 0-repeat solution in < 5 tries.
  const MAX_ATTEMPTS = 20;

  let bestGroups  = null;
  let bestRepeats = Infinity;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const groups  = greedyMatch(users, pairHistory);
    const repeats = countRepeatPairings(groups, pairHistory);

    if (repeats < bestRepeats) {
      bestGroups  = groups;
      bestRepeats = repeats;
    }

    if (bestRepeats === 0) break; // perfect solution — stop early
  }

  return bestGroups.map((members) => ({ users: members }));
}

/**
 * One greedy matching pass over a random shuffle of users.
 * Returns raw arrays (not yet wrapped in { users: ... }).
 */
function greedyMatch(users, pairHistory) {
  const remaining = shuffle([...users]);
  const groups    = [];

  while (remaining.length >= 2) {
    const a          = remaining.shift();
    const partnerIdx = findBestPartnerIndex(a, remaining, pairHistory);
    const [partner]  = remaining.splice(partnerIdx, 1);
    groups.push([a, partner]);
  }

  // One leftover (odd count) — fold into the last pair to make a trio
  if (remaining.length === 1) {
    groups[groups.length - 1].push(remaining[0]);
  }

  return groups;
}

/**
 * Count how many pairs within the proposed groups appear in pairHistory.
 * Used to score attempts — 0 is perfect, higher is worse.
 */
function countRepeatPairings(groups, pairHistory) {
  let count = 0;
  for (const group of groups) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (getMostRecentPairingRoundId(group[i], group[j], pairHistory) !== null) {
          count++;
        }
      }
    }
  }
  return count;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Find the index in `candidates` of the best partner for `user`.
 *
 * Priority:
 *   1. Any candidate with no entry in pairHistory ("fresh" — never recently paired).
 *   2. If all candidates are in pairHistory, pick the one paired least recently
 *      (lowest roundId = oldest = least bad).
 *
 * The input array is already shuffled, so taking the first fresh candidate
 * is effectively a random choice among fresh options.
 */
function findBestPartnerIndex(user, candidates, pairHistory) {
  // Annotate each candidate with the most recent roundId they shared with user
  const annotated = candidates.map((c, idx) => ({
    idx,
    roundId: getMostRecentPairingRoundId(user, c, pairHistory),
  }));

  // Prefer candidates with no recent history at all
  const fresh = annotated.filter((a) => a.roundId === null);
  if (fresh.length > 0) {
    return fresh[0].idx; // already randomised — first is fine
  }

  // Fallback: everyone has been recently paired. Pick the oldest pairing
  // (lowest roundId means it happened furthest in the past).
  annotated.sort((a, b) => a.roundId - b.roundId);
  return annotated[0].idx;
}

/**
 * Returns the most recent roundId for any entry in pairHistory where
 * userA and userB were paired, or null if no entry exists.
 *
 * Checks both orderings (userAId/userBId can appear in either direction).
 */
function getMostRecentPairingRoundId(userA, userB, pairHistory) {
  const entries = pairHistory.filter(
    (h) =>
      (h.userAId === userA.id && h.userBId === userB.id) ||
      (h.userAId === userB.id && h.userBId === userA.id)
  );

  if (entries.length === 0) return null;

  return Math.max(...entries.map((h) => h.roundId));
}

/**
 * Fisher-Yates shuffle. Returns a new array — never mutates input.
 */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { createMatches };
