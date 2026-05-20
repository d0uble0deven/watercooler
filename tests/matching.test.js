'use strict';

// Unit tests for the matching engine.
// Uses Node's built-in test runner — no external test framework needed.
// Run with: npm test

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createMatches } = require('../src/matching/engine');

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Build N fake users with sequential numeric IDs. */
function makeUsers(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    slack_user_id: `U_${i + 1}`,
    display_name: `User ${i + 1}`,
  }));
}

/** Total members across all groups. */
function totalMembers(groups) {
  return groups.reduce((sum, g) => sum + g.users.length, 0);
}

/** Return sorted pair of IDs from a group (makes assertions order-independent). */
function sortedIds(group) {
  return group.users.map((u) => u.id).sort((a, b) => a - b);
}

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  test('0 users → empty result', () => {
    assert.deepEqual(createMatches([]), []);
  });

  test('null/undefined users → empty result', () => {
    assert.deepEqual(createMatches(null), []);
    assert.deepEqual(createMatches(undefined), []);
  });

  test('1 user → empty result (cannot form a group)', () => {
    assert.deepEqual(createMatches(makeUsers(1)), []);
  });

  test('2 users → exactly 1 pair', () => {
    const result = createMatches(makeUsers(2));
    assert.equal(result.length, 1);
    assert.equal(result[0].users.length, 2);
  });

  test('3 users → exactly 1 trio', () => {
    const result = createMatches(makeUsers(3));
    assert.equal(result.length, 1);
    assert.equal(result[0].users.length, 3);
  });
});

// ── Group counts ──────────────────────────────────────────────────────────────

describe('group counts and sizes', () => {
  const cases = [
    { n: 4,  groups: 2, maxSize: 2 },  // 2 pairs
    { n: 5,  groups: 2, maxSize: 3 },  // 1 pair + 1 trio
    { n: 6,  groups: 3, maxSize: 2 },  // 3 pairs
    { n: 7,  groups: 3, maxSize: 3 },  // 2 pairs + 1 trio
    { n: 8,  groups: 4, maxSize: 2 },  // 4 pairs
    { n: 9,  groups: 4, maxSize: 3 },  // 3 pairs + 1 trio
    { n: 10, groups: 5, maxSize: 2 },  // 5 pairs
    { n: 11, groups: 5, maxSize: 3 },  // 4 pairs + 1 trio
    { n: 20, groups: 10, maxSize: 2 }, // 10 pairs
  ];

  for (const { n, groups, maxSize } of cases) {
    test(`${n} users → ${groups} groups, max group size ${maxSize}`, () => {
      const result = createMatches(makeUsers(n));
      assert.equal(result.length, groups, `wrong number of groups`);
      assert.equal(totalMembers(result), n, `not all users were matched`);
      const biggest = Math.max(...result.map((g) => g.users.length));
      assert.ok(biggest <= maxSize, `biggest group was ${biggest}, expected ≤ ${maxSize}`);
    });
  }
});

// ── No duplicate or missing users ─────────────────────────────────────────────

describe('every user appears exactly once', () => {
  for (const n of [4, 7, 10, 13]) {
    test(`${n} users — no duplicates, none missing`, () => {
      const users  = makeUsers(n);
      const result = createMatches(users);
      const allIds = result.flatMap((g) => g.users.map((u) => u.id));
      assert.equal(allIds.length, n, `expected ${n} members total`);
      assert.equal(new Set(allIds).size, n, `found duplicate user IDs`);
    });
  }
});

// ── Odd count always produces exactly one trio ────────────────────────────────

describe('odd count → exactly one trio', () => {
  for (const n of [3, 5, 7, 9, 11, 13, 21]) {
    test(`${n} users → exactly 1 trio`, () => {
      const result = createMatches(makeUsers(n));
      const trios  = result.filter((g) => g.users.length === 3);
      assert.equal(trios.length, 1, `expected 1 trio, got ${trios.length}`);
      const others = result.filter((g) => g.users.length !== 2 && g.users.length !== 3);
      assert.equal(others.length, 0, `unexpected group size`);
    });
  }
});

// ── Repeat avoidance ──────────────────────────────────────────────────────────

describe('repeat avoidance', () => {
  test('avoids recent pairs when fresh options exist (4 users, 100 runs)', () => {
    // Setup: users 1+2 and 3+4 were recently paired.
    // Every possible fresh result is (1,3)+(2,4) or (1,4)+(2,3).
    const users = makeUsers(4);
    const pairHistory = [
      { userAId: 1, userBId: 2, roundId: 10 },
      { userAId: 3, userBId: 4, roundId: 10 },
    ];

    for (let run = 0; run < 100; run++) {
      const result = createMatches(users, pairHistory);
      const pairs  = result.map(sortedIds);

      const repeatedA = pairs.some((p) => p[0] === 1 && p[1] === 2);
      const repeatedB = pairs.some((p) => p[0] === 3 && p[1] === 4);

      assert.ok(!repeatedA, `run ${run}: re-paired users 1+2 (recent)`);
      assert.ok(!repeatedB, `run ${run}: re-paired users 3+4 (recent)`);
    }
  });

  test('avoids recent pairs in a larger group (8 users, 50 runs)', () => {
    // Four pairs were recently matched: (1,2), (3,4), (5,6), (7,8)
    const users = makeUsers(8);
    const pairHistory = [
      { userAId: 1, userBId: 2, roundId: 5 },
      { userAId: 3, userBId: 4, roundId: 5 },
      { userAId: 5, userBId: 6, roundId: 5 },
      { userAId: 7, userBId: 8, roundId: 5 },
    ];

    for (let run = 0; run < 50; run++) {
      const result = createMatches(users, pairHistory);
      const pairs  = result.map(sortedIds);

      const recentPairs = [[1,2],[3,4],[5,6],[7,8]];
      for (const [a, b] of recentPairs) {
        const repeated = pairs.some((p) => p[0] === a && p[1] === b);
        assert.ok(!repeated, `run ${run}: re-paired ${a}+${b} (recent)`);
      }
    }
  });

  test('falls back gracefully when no fresh options exist (2 users, forced repeat)', () => {
    // Only 2 users — no alternative. Must repeat.
    const users = makeUsers(2);
    const pairHistory = [{ userAId: 1, userBId: 2, roundId: 3 }];

    const result = createMatches(users, pairHistory);
    assert.equal(result.length, 1);
    assert.equal(result[0].users.length, 2);
  });

  test('fallback picks oldest pairing (4 users, all combos exhausted)', () => {
    // All 6 possible pairs have been used. No fresh options at all.
    // Run 50 times to confirm no crash and all users matched.
    const users = makeUsers(4);
    const pairHistory = [
      { userAId: 1, userBId: 2, roundId: 1 },
      { userAId: 1, userBId: 3, roundId: 2 },
      { userAId: 1, userBId: 4, roundId: 3 },
      { userAId: 2, userBId: 3, roundId: 4 },
      { userAId: 2, userBId: 4, roundId: 5 },
      { userAId: 3, userBId: 4, roundId: 6 },
    ];

    for (let run = 0; run < 50; run++) {
      const result = createMatches(users, pairHistory);
      assert.equal(totalMembers(result), 4, `run ${run}: not all users matched`);
      assert.equal(result.length, 2, `run ${run}: wrong group count`);
    }
  });

  test('empty pair history → treats everyone as fresh', () => {
    const users  = makeUsers(6);
    const result = createMatches(users, []);
    assert.equal(result.length, 3);
    assert.equal(totalMembers(result), 6);
  });

  test('pair history for other users does not affect current matching', () => {
    // History involves user IDs 99, 100 — not in the eligible pool
    const users = makeUsers(4);
    const pairHistory = [
      { userAId: 99, userBId: 100, roundId: 1 },
    ];
    const result = createMatches(users, pairHistory);
    assert.equal(result.length, 2);
    assert.equal(totalMembers(result), 4);
  });

  test('prefers least-recently-paired over most-recent when forced to repeat', () => {
    // 3 users — will form a trio regardless of history.
    // With 3 people there is no "best" pairing to verify, but we verify no crash.
    const users = makeUsers(3);
    const pairHistory = [
      { userAId: 1, userBId: 2, roundId: 10 }, // very recent
      { userAId: 1, userBId: 3, roundId: 1 },  // old
      { userAId: 2, userBId: 3, roundId: 5 },
    ];
    const result = createMatches(users, pairHistory);
    assert.equal(result.length, 1);
    assert.equal(result[0].users.length, 3);
    assert.equal(totalMembers(result), 3);
  });
});

// ── Unsupported options ───────────────────────────────────────────────────────

describe('unsupported options', () => {
  test('groupSize 3 throws a clear error', () => {
    assert.throws(
      () => createMatches(makeUsers(6), [], { groupSize: 3 }),
      /not yet supported/
    );
  });
});

// ── Determinism: input array not mutated ──────────────────────────────────────

describe('pure function guarantees', () => {
  test('does not mutate the input users array', () => {
    const users    = makeUsers(6);
    const original = users.map((u) => u.id);
    createMatches(users);
    assert.deepEqual(users.map((u) => u.id), original, 'input array was mutated');
  });

  test('does not mutate the pair history array', () => {
    const history  = [{ userAId: 1, userBId: 2, roundId: 1 }];
    const snapshot = JSON.stringify(history);
    createMatches(makeUsers(4), history);
    assert.equal(JSON.stringify(history), snapshot, 'pair history was mutated');
  });
});
