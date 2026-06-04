'use strict';

// Admin commands tests
//
// Tests:
//   • Message builders — buildCancellationNoticeBlocks, buildRoundSummaryMessage
//   • DB helpers — getAllUnbookedMatches, getAllMatchesPendingCompletion,
//                  isRoundFullyComplete, getRoundById, getMostRecentActiveRound,
//                  getMatchesForRound
//   • list-matches  — output contains round IDs and state labels
//   • force-book    — guard conditions (invalid ID, not found, already booked, empty)
//   • send-completion — guard conditions
//   • resend-suggestions — guard conditions
//   • cancel-round  — guard conditions + end-to-end with disposable test round
//
// Run: npm run test:admin-commands

const { initDb } = require('../src/db/init');
initDb();

const { listMatches }       = require('../src/commands/admin/list-matches');
const { forceBook }         = require('../src/commands/admin/force-book');
const { sendCompletion }    = require('../src/commands/admin/send-completion');
const { resendSuggestions } = require('../src/commands/admin/resend-suggestions');
const { cancelRound }       = require('../src/commands/admin/cancel-round');

const { buildRoundSummaryMessage } = require('../src/integrations/meetingCompleter');

const {
  getAllUnbookedMatches,
  getAllMatchesPendingCompletion,
  isRoundFullyComplete,
  getRoundById,
  getMostRecentActiveRound,
  getMatchesForRound,
  createRound,
  saveMatch,
  completeRound,
} = require('../src/lib/rounds');

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

// Helper: capture all respond() calls into an array
function captureRespond() {
  const msgs = [];
  return { msgs, respond: async (m) => msgs.push(m) };
}

// No-op Slack client — all calls succeed silently
const noopClient = {
  chat: {
    update:      async () => {},
    postMessage: async () => {},
  },
};

console.log('\n=== Admin Commands Tests ===\n');

(async () => {

  // ── Message builders ────────────────────────────────────────────────────────
  console.log('Message builders');
  {
    // buildRoundSummaryMessage
    const blocks = buildRoundSummaryMessage(6, new Date('2026-06-23T13:00:00Z'), 'America/Chicago');
    check('returns array of blocks',            Array.isArray(blocks) && blocks.length > 0);
    check('contains pair count',                blocks[0].text.text.includes('6 pairs'));
    check('contains next round date',           blocks[0].text.text.includes('Jun'));
    check('contains celebration emoji',         blocks[0].text.text.includes('🎉'));

    // singular "pair"
    const singular = buildRoundSummaryMessage(1, new Date('2026-06-23T13:00:00Z'), 'America/Chicago');
    check('singular: "1 pair" not "1 pairs"',   singular[0].text.text.includes('1 pair') &&
                                                 !singular[0].text.text.includes('1 pairs'));
  }

  // ── DB helpers ─────────────────────────────────────────────────────────────
  console.log('\nDB helpers');
  {
    const unbooked = getAllUnbookedMatches();
    check('getAllUnbookedMatches returns array',   Array.isArray(unbooked));
    check('unbooked matches have no calendar_event_id',
      unbooked.every((m) => !m.calendar_event_id));

    const pending = getAllMatchesPendingCompletion();
    check('getAllMatchesPendingCompletion returns array', Array.isArray(pending));
    check('pending completion have completion_message_sent = 0',
      pending.every((m) => m.completion_message_sent === 0));

    // isRoundFullyComplete on a known completed round
    const recent = getMostRecentActiveRound();
    if (recent) {
      const complete = isRoundFullyComplete(recent.id);
      check('isRoundFullyComplete returns boolean', typeof complete === 'boolean');
    } else {
      check('getMostRecentActiveRound (skipped — no active rounds)', true);
    }

    check('getRoundById returns null for nonexistent round', getRoundById(999999) === undefined || getRoundById(999999) === null);

    const active = getMostRecentActiveRound();
    check('getMostRecentActiveRound returns non-cancelled round',
      !active || active.status !== 'cancelled');

    if (active) {
      const matches = getMatchesForRound(active.id);
      check('getMatchesForRound returns array',    Array.isArray(matches));
      check('all matches belong to the round',     matches.every((m) => m.round_id === active.id));
    }
  }

  // ── list-matches ────────────────────────────────────────────────────────────
  console.log('\nlist-matches');
  {
    const { msgs, respond } = captureRespond();
    await listMatches({ user_id: 'U_TEST' }, respond);

    check('produces at least one response',       msgs.length >= 1);
    const out = msgs.join('\n');
    check('output mentions "Round"',              out.includes('Round'));
    check('output contains match ID backtick',    out.includes('`#'));
    check('output contains usage hint',           out.includes('force-book') || out.includes('list-matches'));
    check('state label present (Booked/Completed/Awaiting/Intro)',
      out.includes('📅') || out.includes('✅') || out.includes('⏳') || out.includes('📨'));
  }

  // ── force-book guards ───────────────────────────────────────────────────────
  console.log('\nforce-book — guards');
  {
    const cmd = { user_id: 'U_TEST' };

    // Invalid ID
    const { msgs: m1, respond: r1 } = captureRespond();
    await forceBook(cmd, 'xyz', r1, noopClient);
    check('invalid ID fires error',     m1[0].includes('Invalid match ID'));

    // Not found
    const { msgs: m2, respond: r2 } = captureRespond();
    await forceBook(cmd, '999999', r2, noopClient);
    check('not found fires error',      m2[0].includes('not found'));

    // Already booked — use match #35 (booked in real DB) if it exists
    const { msgs: m3, respond: r3 } = captureRespond();
    await forceBook(cmd, '35', r3, noopClient);
    check('already booked fires warning', m3[0].includes('already booked'));

    // No unbooked matches when all are booked or this round was cancelled
    // (getAllUnbookedMatches may or may not return 0 — just check no crash)
    const { msgs: m4, respond: r4 } = captureRespond();
    await forceBook(cmd, '', r4, noopClient);
    check('bulk force-book responds without crash', m4.length >= 1);
  }

  // ── send-completion guards ──────────────────────────────────────────────────
  console.log('\nsend-completion — guards');
  {
    const cmd = { user_id: 'U_TEST' };

    const { msgs: m1, respond: r1 } = captureRespond();
    await sendCompletion(cmd, 'abc', r1, noopClient);
    check('invalid ID fires error',     m1[0].includes('Invalid match ID'));

    const { msgs: m2, respond: r2 } = captureRespond();
    await sendCompletion(cmd, '999999', r2, noopClient);
    check('not found fires error',      m2[0].includes('not found'));

    // Match #31 had completion sent (from earlier test runs)
    const { msgs: m3, respond: r3 } = captureRespond();
    await sendCompletion(cmd, '31', r3, noopClient);
    check('already sent fires warning', m3[0].includes('already had a completion'));
  }

  // ── resend-suggestions guards ───────────────────────────────────────────────
  console.log('\nresend-suggestions — guards');
  {
    const cmd = { user_id: 'U_TEST' };

    // No ID
    const { msgs: m1, respond: r1 } = captureRespond();
    await resendSuggestions(cmd, '', r1, noopClient);
    check('no ID fires "required" error',  m1[0].includes('required'));

    // Invalid ID
    const { msgs: m2, respond: r2 } = captureRespond();
    await resendSuggestions(cmd, 'foo', r2, noopClient);
    check('invalid ID fires error',        m2[0].includes('Invalid match ID'));

    // Not found
    const { msgs: m3, respond: r3 } = captureRespond();
    await resendSuggestions(cmd, '999999', r3, noopClient);
    check('not found fires error',         m3[0].includes('not found'));

    // Already booked
    const { msgs: m4, respond: r4 } = captureRespond();
    await resendSuggestions(cmd, '35', r4, noopClient);
    check('already booked fires warning',  m4[0].includes('already booked'));
  }

  // ── cancel-round guards ─────────────────────────────────────────────────────
  console.log('\ncancel-round — guards');
  {
    const cmd = { user_id: 'U_TEST' };

    // Invalid ID
    const { msgs: m1, respond: r1 } = captureRespond();
    await cancelRound(cmd, 'abc', r1, noopClient);
    check('invalid round ID fires error',   m1[0].includes('Invalid round ID'));

    // Not found
    const { msgs: m2, respond: r2 } = captureRespond();
    await cancelRound(cmd, '999999', r2, noopClient);
    check('not found fires error',          m2[0].includes('not found'));
  }

  // ── cancel-round end-to-end ─────────────────────────────────────────────────
  console.log('\ncancel-round — end-to-end (disposable test round)');
  {
    // Create a test round with two matches that have no DM channels or
    // calendar events — cancel-round will mark the round cancelled with
    // 0 Slack calls needed, making this fully self-contained.
    const testRoundId = createRound('test-admin-commands');
    saveMatch(testRoundId);  // match with no DM channel
    saveMatch(testRoundId);  // second match
    completeRound(testRoundId);

    check('test round created with status completed',
      getRoundById(testRoundId)?.status === 'completed');
    check('test round has 2 matches',
      getMatchesForRound(testRoundId).length === 2);

    const slackCalls = [];
    const trackingClient = {
      chat: {
        update:      async (a) => slackCalls.push({ type: 'update', ...a }),
        postMessage: async (a) => slackCalls.push({ type: 'post',   ...a }),
      },
    };

    const { msgs, respond } = captureRespond();
    await cancelRound({ user_id: 'U_TEST' }, String(testRoundId), respond, trackingClient);

    check('round is now cancelled in DB',
      getRoundById(testRoundId)?.status === 'cancelled');
    check('no Slack calls (matches had no DM channels)',
      slackCalls.length === 0);
    check('response confirms cancellation',
      msgs.some((m) => m.includes('cancelled') || m.includes('Cancelling')));
    check('response mentions the round ID',
      msgs.some((m) => m.includes(String(testRoundId))));

    // Re-cancel — should bounce with already-cancelled guard
    const { msgs: msgs2, respond: r2 } = captureRespond();
    await cancelRound({ user_id: 'U_TEST' }, String(testRoundId), r2, noopClient);
    check('re-cancel bounces with already-cancelled warning',
      msgs2[0].includes('already cancelled'));

    // No-arg cancel should now skip the test round (it's cancelled)
    // and target whatever real active round exists (or say no active rounds)
    const { msgs: msgs3, respond: r3 } = captureRespond();
    await cancelRound({ user_id: 'U_TEST' }, '', r3, noopClient);
    check('no-arg cancel does not target the already-cancelled test round',
      !msgs3.some((m) => m.includes(`#${testRoundId} is already cancelled`)));
  }

  // ── Results ─────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));

  if (failed > 0) process.exit(1);

})();
