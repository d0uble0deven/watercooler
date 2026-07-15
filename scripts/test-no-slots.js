'use strict';

// No-slots spam fix tests
//
// Bug: the auto-booker re-posted "Booking deadline passed — no slots found"
// every scheduler tick, because the no-slots branch wrote no DB state and the
// match stayed selectable forever.
//
// Fix under test: matches.no_slots_notified_at is stamped after the first
// notice; getUnbookedMatchesPastDeadline excludes stamped matches. Manual
// recovery paths (claimBooking, resend-suggestions) must remain unaffected.
//
// Run: npm run test:no-slots

const { initDb } = require('../src/db/init');
initDb();

// ── Force the no-slots path BEFORE loading the auto-booker ──────────────────
// calendarAutoBooker destructures these at require time, so patching the
// modules first means no real Graph calls and guaranteed "no slots".
const calendarReader = require('../src/integrations/calendarReader');
const slotFinder     = require('../src/lib/slotFinder');
calendarReader.getFreeBusy = async () => ({});
slotFinder.findSlots       = () => [];

const { runAutoBooking } = require('../src/integrations/calendarAutoBooker');

const {
  createRound, saveMatch, saveMatchMembers, completeRound, updateMatchChannel,
  getMatch, getUnbookedMatchesPastDeadline, markNoSlotsNotified,
  claimBooking, releaseBookingClaim, getSettings, updateSettings,
} = require('../src/lib/rounds');
const { createUser, saveUserEmail } = require('../src/lib/users');
const { resendSuggestions } = require('../src/commands/admin/resend-suggestions');
const { getDb } = require('../src/db/connection');

let passed = 0;
let failed = 0;

function check(label, condition, actual) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    if (actual !== undefined) console.error(`     Got: ${JSON.stringify(actual)}`);
    failed++;
  }
}

function cleanup() {
  const db = getDb();
  db.exec(`DELETE FROM match_members WHERE match_id IN (
             SELECT m.id FROM matches m JOIN rounds r ON r.id = m.round_id
             WHERE r.created_by = 'test-no-slots')`);
  db.exec(`DELETE FROM matches WHERE round_id IN (SELECT id FROM rounds WHERE created_by = 'test-no-slots')`);
  db.exec(`DELETE FROM rounds WHERE created_by = 'test-no-slots'`);
  db.exec(`DELETE FROM users WHERE slack_user_id LIKE 'U_NOSLOT_%'`);
}

console.log('\n=== No-Slots Spam Fix Tests ===\n');

const originalSettings = getSettings();

(async () => {
  cleanup();
  updateSettings({ calendar_enabled: 1 });

  // ── Fixture: a completed round past the deadline, with an unbooked match ──
  const roundId = createRound('test-no-slots');
  const matchId = saveMatch(roundId);
  const u1 = createUser('U_NOSLOT_1', 'NoSlot One');
  const u2 = createUser('U_NOSLOT_2', 'NoSlot Two');
  saveUserEmail('U_NOSLOT_1', 'one@example.test');
  saveUserEmail('U_NOSLOT_2', 'two@example.test');
  saveMatchMembers(matchId, [u1.id, u2.id]);
  updateMatchChannel(matchId, 'C_NOSLOT_TEST');
  completeRound(roundId);
  // Backdate the round well past the 2.5-day booking deadline
  getDb().prepare(`UPDATE rounds SET completed_at = datetime('now', '-4 days') WHERE id = ?`).run(roundId);

  // ── Column + helper ─────────────────────────────────────────────────────────
  console.log('migration + helper');
  {
    const cols = getDb().prepare('PRAGMA table_info(matches)').all().map((c) => c.name);
    check('matches.no_slots_notified_at column exists', cols.includes('no_slots_notified_at'));
    check('new match starts unstamped', getMatch(matchId).no_slots_notified_at === null);
  }

  // ── The spam regression: two ticks, one message ─────────────────────────────
  console.log('\nauto-booker ticks (the spam regression)');
  {
    const posts = [];
    const client = {
      chat: {
        postMessage: async (m) => posts.push(m),
        update:      async (m) => posts.push(m),
      },
    };

    check('match is selectable before first tick',
      getUnbookedMatchesPastDeadline(52).some((m) => m.id === matchId));

    await runAutoBooking(client, getSettings());   // tick 1
    check('tick 1 posts exactly one no-slots message', posts.length === 1, posts.length);
    check('tick 1 stamped the match', !!getMatch(matchId).no_slots_notified_at);
    check('match no longer selectable', !getUnbookedMatchesPastDeadline(52).some((m) => m.id === matchId));

    await runAutoBooking(client, getSettings());   // tick 2
    await runAutoBooking(client, getSettings());   // tick 3
    check('ticks 2+3 post nothing (spam fixed)', posts.length === 1, posts.length);
  }

  // ── Recovery paths stay open ────────────────────────────────────────────────
  console.log('\nmanual recovery paths (must NOT be blocked by the stamp)');
  {
    // A user clicking a lingering slot button must still be able to claim
    check('claimBooking still succeeds on stamped match', claimBooking(matchId) === true);
    releaseBookingClaim(matchId);
    check('claim released cleanly', getMatch(matchId).calendar_event_id === null);

    // resend-suggestions must not report "already booked"
    const msgs = [];
    const mockClient = { users: { info: async () => ({}) }, chat: { postMessage: async () => ({}) } };
    await resendSuggestions({ user_id: 'U_ADMIN' }, String(matchId), async (m) => msgs.push(m), mockClient);
    check('resend-suggestions does not say "already booked"',
      msgs.length > 0 && !msgs[0].includes('already booked'), msgs[0]);
  }

  // ── markNoSlotsNotified direct ──────────────────────────────────────────────
  console.log('\nmarkNoSlotsNotified');
  {
    const m2 = saveMatch(roundId);
    updateMatchChannel(m2, 'C_NOSLOT_TEST2');
    check('fresh match selectable', getUnbookedMatchesPastDeadline(52).some((m) => m.id === m2));
    markNoSlotsNotified(m2);
    check('stamped match excluded', !getUnbookedMatchesPastDeadline(52).some((m) => m.id === m2));
    check('stamp is a timestamp string', typeof getMatch(m2).no_slots_notified_at === 'string');
  }

  // ── Restore + results ───────────────────────────────────────────────────────
  cleanup();
  updateSettings({ calendar_enabled: originalSettings.calendar_enabled });

  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));

  if (failed > 0) process.exit(1);
})();
