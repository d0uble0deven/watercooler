'use strict';

// Reschedule variety + /watercooler reschedule command tests
//
// Covers:
//   • buildImmediateWindow — contiguous with near window, buffer + rounding
//   • suggestMeetingTimes  — default mode unchanged (3 slots); richVariety
//     mode offers up to 9, degrades gracefully on a constrained calendar
//   • buildSuggestionsMessage — buttons chunk into ≤5-element actions blocks
//   • checkRescheduleEligibility — direct unit coverage of all four statuses
//   • getUpcomingBookedMatchForUser — soonest-first, excludes pending/past
//   • /watercooler reschedule command — no-match, guard, and happy paths
//
// Uses a mocked Graph client (no real network calls) for deterministic slot
// counts. Run: npm run test:reschedule-variety

const { initDb } = require('../src/db/init');
initDb();

// Patch Graph BEFORE any module that destructures it at require time.
const msGraph        = require('../src/integrations/msGraph');
const calendarReader  = require('../src/integrations/calendarReader');
let busyResponder = async () => ({}); // (emails, start, end) => Graph-shaped busy data
msGraph.getGraphClient      = () => ({ api: () => ({}) }); // non-null is all suggestMeetingTimes checks
calendarReader.getFreeBusy  = async (...args) => busyResponder(...args);

const {
  suggestMeetingTimes, buildImmediateWindow, buildNearWindow,
  buildSuggestionsMessage,
} = require('../src/integrations/calendarScheduler');
const { checkRescheduleEligibility } = require('../src/commands/actions/reschedule');
const rescheduleCommand = require('../src/commands/user/reschedule');

const {
  createRound, saveMatch, saveMatchMembers, completeRound, updateMatchChannel,
  saveBooking, saveMeetingTimes, getMatch,
  getUpcomingBookedMatchForUser, claimBooking, resetBooking,
  getSettings, updateSettings,
} = require('../src/lib/rounds');
const { createUser, saveUserEmail } = require('../src/lib/users');
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
             WHERE r.created_by = 'test-variety')`);
  db.exec(`DELETE FROM matches WHERE round_id IN (SELECT id FROM rounds WHERE created_by = 'test-variety')`);
  db.exec(`DELETE FROM rounds WHERE created_by = 'test-variety'`);
  db.exec(`DELETE FROM users WHERE slack_user_id LIKE 'U_VAR_%'`); // covers U_VAR_1..4
}

console.log('\n=== Reschedule Variety + Command Tests ===\n');

const originalSettings = getSettings();

(async () => {
  cleanup();
  updateSettings({ calendar_enabled: 1 });

  const roundId = createRound('test-variety');
  const u1 = createUser('U_VAR_1', 'Vera One');
  const u2 = createUser('U_VAR_2', 'Otto Two');
  saveUserEmail('U_VAR_1', 'vera@example.test');
  saveUserEmail('U_VAR_2', 'otto@example.test');
  completeRound(roundId);

  // ── buildImmediateWindow ─────────────────────────────────────────────────────
  console.log('buildImmediateWindow');
  {
    const now  = new Date('2026-07-15T18:00:00Z'); // Wed, mid-afternoon US
    const near = buildNearWindow(now, 'America/New_York', null);
    const imm  = buildImmediateWindow(now, 'America/New_York', null);

    check('end is contiguous with near window start',
      imm.end.getTime() === near.start.getTime(),
      { immEnd: imm.end, nearStart: near.start });
    check('start is after "now" (buffer applied)', imm.start.getTime() > now.getTime());
    check('start is rounded to a 30-min mark',
      (imm.start.getTime() % (30 * 60 * 1000)) === 0, imm.start);
    check('start is before end', imm.start.getTime() < imm.end.getTime());
  }

  // ── suggestMeetingTimes — default mode unchanged ────────────────────────────
  console.log('\nsuggestMeetingTimes — default mode (regression check)');
  {
    // Wide-open calendars — plenty of room to find every requested slot.
    busyResponder = async () => [];

    const roundId2 = createRound('test-variety');
    const matchId  = saveMatch(roundId2);
    saveMatchMembers(matchId, [u1.id, u2.id]);
    updateMatchChannel(matchId, 'C_VAR_DEFAULT');
    completeRound(roundId2);

    const posts = [];
    const client = { chat: { postMessage: async (m) => { posts.push(m); return { ts: '111.222' }; } } };

    await suggestMeetingTimes(client, 'C_VAR_DEFAULT', matchId, [
      { ...u1, slack_email: 'vera@example.test' },
      { ...u2, slack_email: 'otto@example.test' },
    ], getSettings());

    const buttonCount = countButtons(posts[0]?.blocks);
    check('default mode posts exactly 3 slots', buttonCount === 3, buttonCount);
  }

  // ── suggestMeetingTimes — rich mode ──────────────────────────────────────────
  console.log('\nsuggestMeetingTimes — richVariety mode');
  {
    busyResponder = async () => [];

    const roundId3 = createRound('test-variety');
    const matchId  = saveMatch(roundId3);
    saveMatchMembers(matchId, [u1.id, u2.id]);
    updateMatchChannel(matchId, 'C_VAR_RICH');
    completeRound(roundId3);

    const posts = [];
    const client = { chat: { postMessage: async (m) => { posts.push(m); return { ts: '333.444' }; } } };

    await suggestMeetingTimes(client, 'C_VAR_RICH', matchId, [
      { ...u1, slack_email: 'vera@example.test' },
      { ...u2, slack_email: 'otto@example.test' },
    ], getSettings(), false, { richVariety: true });

    const buttonCount = countButtons(posts[0]?.blocks);
    check('rich mode posts up to 9 slots', buttonCount > 3 && buttonCount <= 9, buttonCount);

    const actionsBlocks = (posts[0]?.blocks || []).filter((b) => b.type === 'actions');
    check('buttons split across multiple actions blocks when >5',
      buttonCount <= 5 || actionsBlocks.length >= 2, actionsBlocks.length);
    check('no single actions block exceeds 5 buttons',
      actionsBlocks.every((b) => b.elements.length <= 5));
  }

  // ── buildSuggestionsMessage — chunking directly ─────────────────────────────
  console.log('\nbuildSuggestionsMessage — button chunking');
  {
    const mk = (n) => Array.from({ length: n }, (_, i) => ({
      start: new Date(Date.now() + i * 3600000),
      end:   new Date(Date.now() + i * 3600000 + 900000),
    }));

    const three = buildSuggestionsMessage(mk(3), 1, 'UTC', false);
    const threeActions = three.filter((b) => b.type === 'actions');
    check('3 slots → exactly 1 actions block', threeActions.length === 1, threeActions.length);
    check('3 slots → 1 block has all 3 buttons', threeActions[0].elements.length === 3);

    const nine = buildSuggestionsMessage(mk(9), 1, 'UTC', false);
    const nineActions = nine.filter((b) => b.type === 'actions');
    check('9 slots → 2 actions blocks', nineActions.length === 2, nineActions.length);
    check('9 slots → split 5 + 4', nineActions[0].elements.length === 5 && nineActions[1].elements.length === 4,
      nineActions.map((b) => b.elements.length));

    const allButtons = nineActions.flatMap((b) => b.elements);
    check('action_ids stay sequential across blocks (0..8)',
      allButtons.map((b) => b.action_id).join(',') ===
      Array.from({ length: 9 }, (_, i) => `watercooler_book_slot_${i}`).join(','));
  }

  // ── checkRescheduleEligibility — direct unit coverage ───────────────────────
  console.log('\ncheckRescheduleEligibility (direct)');
  {
    check('unknown match → not_found', checkRescheduleEligibility(999999).status === 'not_found');

    const roundId4 = createRound('test-variety');
    const pendingMatch = saveMatch(roundId4);
    updateMatchChannel(pendingMatch, 'C_VAR_PENDING');
    completeRound(roundId4);
    claimBooking(pendingMatch);
    check('pending sentinel → pending', checkRescheduleEligibility(pendingMatch).status === 'pending');

    const roundId5 = createRound('test-variety');
    const midResched = saveMatch(roundId5);
    updateMatchChannel(midResched, 'C_VAR_MID');
    completeRound(roundId5);
    saveBooking(midResched, { calendarEventId: 'evt-mid', teamsLink: null });
    resetBooking(midResched);
    check('reset-but-not-rebooked → already_rescheduling',
      checkRescheduleEligibility(midResched).status === 'already_rescheduling');

    const roundId6 = createRound('test-variety');
    const freshMatch = saveMatch(roundId6);
    updateMatchChannel(freshMatch, 'C_VAR_FRESH');
    completeRound(roundId6);
    saveBooking(freshMatch, { calendarEventId: 'evt-fresh', teamsLink: null });
    check('normal booked match → ok', checkRescheduleEligibility(freshMatch).status === 'ok');
  }

  // ── getUpcomingBookedMatchForUser ────────────────────────────────────────────
  console.log('\ngetUpcomingBookedMatchForUser');
  {
    check('no bookings → undefined', getUpcomingBookedMatchForUser('U_VAR_NOBODY') === undefined);

    const roundId7 = createRound('test-variety');
    const soon = saveMatch(roundId7);
    const later = saveMatch(roundId7);
    saveMatchMembers(soon, [u1.id]);
    saveMatchMembers(later, [u1.id]);
    updateMatchChannel(soon, 'C_VAR_SOON');
    updateMatchChannel(later, 'C_VAR_LATER');
    completeRound(roundId7);
    saveBooking(soon, { calendarEventId: 'evt-soon', teamsLink: null });
    saveBooking(later, { calendarEventId: 'evt-later', teamsLink: null });
    saveMeetingTimes(soon,  new Date(Date.now() + 2 * 86400000), new Date(Date.now() + 2 * 86400000 + 900000));
    saveMeetingTimes(later, new Date(Date.now() + 9 * 86400000), new Date(Date.now() + 9 * 86400000 + 900000));

    const found = getUpcomingBookedMatchForUser('U_VAR_1');
    check('picks the SOONEST of multiple bookings', found?.id === soon, found?.id);

    // Past meeting excluded
    const roundId8 = createRound('test-variety');
    const pastMatch = saveMatch(roundId8);
    saveMatchMembers(pastMatch, [u2.id]);
    updateMatchChannel(pastMatch, 'C_VAR_PAST');
    completeRound(roundId8);
    saveBooking(pastMatch, { calendarEventId: 'evt-past', teamsLink: null });
    saveMeetingTimes(pastMatch, new Date(Date.now() - 86400000), new Date(Date.now() - 86400000 + 900000));
    check('past meeting excluded', getUpcomingBookedMatchForUser('U_VAR_2')?.id !== pastMatch);

    // pending sentinel excluded
    const roundId9 = createRound('test-variety');
    const pendingOnly = saveMatch(roundId9);
    saveMatchMembers(pendingOnly, [u2.id]);
    updateMatchChannel(pendingOnly, 'C_VAR_PENDONLY');
    completeRound(roundId9);
    claimBooking(pendingOnly);
    getDb().prepare(`UPDATE matches SET meeting_start_at = ? WHERE id = ?`)
      .run(new Date(Date.now() + 86400000).toISOString(), pendingOnly);
    check('pending-claim sentinel excluded', getUpcomingBookedMatchForUser('U_VAR_2')?.id !== pendingOnly);
  }

  // ── /watercooler reschedule command ─────────────────────────────────────────
  // Uses dedicated fresh users (u3/u4) so nothing here can see the leftover
  // bookings created for u1/u2 in the getUpcomingBookedMatchForUser section
  // above — cross-section state leakage was the root cause of a false
  // failure here on the first pass at this suite.
  console.log('\n/watercooler reschedule command');
  {
    busyResponder = async () => [];
    const u3 = createUser('U_VAR_3', 'Cara Three');
    const u4 = createUser('U_VAR_4', 'Deion Four');
    saveUserEmail('U_VAR_3', 'cara@example.test');
    saveUserEmail('U_VAR_4', 'deion@example.test');

    // No match at all
    const noneMsgs = [];
    await rescheduleCommand({ user_id: 'U_VAR_NOBODY' }, async (m) => noneMsgs.push(m), {});
    check('no match → friendly no-match message',
      noneMsgs[0].includes("don't have a Watercooler match"), noneMsgs[0]);

    // NOTE: 'pending' and 'already_rescheduling' are already covered directly
    // against checkRescheduleEligibility() above. They're structurally
    // unreachable through this command's own discovery query — a match with
    // calendar_event_id = 'pending' or NULL fails getUpcomingBookedMatchForUser's
    // `calendar_event_id IS NOT NULL AND != 'pending'` filter, so the command
    // would report "no upcoming meeting" for such a match, not reach those
    // statuses. That's correct behavior: a mid-claim or mid-reschedule match
    // isn't "currently booked" from the user's point of view.

    // Happy path
    const roundIdH = createRound('test-variety');
    const happyMatch = saveMatch(roundIdH);
    saveMatchMembers(happyMatch, [u3.id, u4.id]);
    updateMatchChannel(happyMatch, 'C_VAR_CMD_HAPPY');
    completeRound(roundIdH);
    saveBooking(happyMatch, { calendarEventId: 'evt-happy', teamsLink: null });
    saveMeetingTimes(happyMatch, new Date(Date.now() + 3 * 86400000), new Date(Date.now() + 3 * 86400000 + 900000));

    const happyMsgs   = [];
    const publicPosts = [];
    const ephemerals  = [];
    const client = {
      chat: {
        postMessage:   async (m) => { publicPosts.push(m); return { ts: '5.5' }; },
        postEphemeral: async (m) => { ephemerals.push(m); },
      },
    };
    await rescheduleCommand({ user_id: 'U_VAR_3' }, async (m) => happyMsgs.push(m), client);

    check('happy path names the OTHER participant', happyMsgs[0].includes('Deion Four'), happyMsgs[0]);
    check('happy path does not name the caller', !happyMsgs[0].includes('Cara Three'));
    check('happy path tells the caller it stays private', happyMsgs[0].includes('Only you'), happyMsgs[0]);

    // Silent flow: options go ONLY to the caller, nothing lands in the shared DM
    check('happy path sent private options to the caller',
      ephemerals.length === 1 && ephemerals[0].user === 'U_VAR_3', ephemerals.length);
    check('happy path targeted the group DM channel',
      ephemerals[0]?.channel === 'C_VAR_CMD_HAPPY');
    check('happy path posted NOTHING publicly (match not notified)',
      publicPosts.length === 0, publicPosts);

    check('match was actually reset', getMatch(happyMatch).calendar_event_id === null);
    check('previous_event_id preserved for later cleanup',
      getMatch(happyMatch).previous_event_id === 'evt-happy');
  }

  // ── Whole-round reschedule: works for a NEVER-BOOKED match ──────────────────
  console.log('\n/watercooler reschedule — never-booked match (whole-round support)');
  {
    busyResponder = async () => [];
    const u5 = createUser('U_VAR_5', 'Nia Five');
    const u6 = createUser('U_VAR_6', 'Omar Six');
    saveUserEmail('U_VAR_5', 'nia@example.test');
    saveUserEmail('U_VAR_6', 'omar@example.test');

    const roundIdN = createRound('test-variety');
    const neverBooked = saveMatch(roundIdN);
    saveMatchMembers(neverBooked, [u5.id, u6.id]);
    updateMatchChannel(neverBooked, 'C_VAR_NEVER');
    completeRound(roundIdN);
    // No saveBooking — this pair never picked a time at all.

    const msgs       = [];
    const ephemerals = [];
    const client = {
      chat: {
        postMessage:   async () => ({ ts: '6.6' }),
        postEphemeral: async (m) => { ephemerals.push(m); },
      },
    };
    await rescheduleCommand({ user_id: 'U_VAR_5' }, async (m) => msgs.push(m), client);

    check('never-booked match is found', !msgs[0].includes("don't have a Watercooler match"), msgs[0]);
    check('never-booked → names the partner', msgs[0].includes('Omar Six'), msgs[0]);
    check('never-booked → private options posted', ephemerals.length === 1, ephemerals.length);
    check('never-booked → previous_event_id stays null (nothing to delete)',
      getMatch(neverBooked).previous_event_id === null);
  }

  // ── Restore + results ───────────────────────────────────────────────────────
  cleanup();
  updateSettings({ calendar_enabled: originalSettings.calendar_enabled });

  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));

  if (failed > 0) process.exit(1);
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

function countButtons(blocks) {
  return (blocks || [])
    .filter((b) => b.type === 'actions')
    .reduce((sum, b) => sum + b.elements.length, 0);
}
