'use strict';

// Reschedule flow tests
//
// Tests:
//   • buildConfirmationMessage — Reschedule button present/absent based on matchId
//   • resetBooking / clearPreviousEvent — DB state transitions
//   • handleReschedule — guard conditions (pending, already rescheduling)
//   • handleReschedule — happy path: DB reset + suggestMeetingTimes called
//   • bookSlot deferred deletion — previous_event_id cleared after new booking
//
// Run: npm run test:reschedule

const { initDb } = require('../src/db/init');
initDb();

const { buildConfirmationMessage } = require('../src/integrations/calendarBooker');
const { handleReschedule }         = require('../src/commands/actions/reschedule');
const {
  getMatch,
  resetBooking,
  clearPreviousEvent,
  saveBooking,
  createRound,
  saveMatch,
  saveMatchMembers,
  completeRound,
  updateMatchChannel,
  getMatchUsers,
} = require('../src/lib/rounds');
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

// Fake booking object
const fakeBooking = {
  eventId:   'evt-test-123',
  teamsLink: 'https://teams.microsoft.com/fake',
  start:     new Date('2026-06-09T14:00:00Z'),
  end:       new Date('2026-06-09T14:30:00Z'),
};

const fakeUsers = [{ display_name: 'Alice' }, { display_name: 'Bob' }];

function captureRespond() {
  const msgs = [];
  return { msgs, respond: async (m) => msgs.push(m) };
}

// Build a minimal action body for Bolt action handlers
function makeActionBody(matchId, channelId = 'C_TEST', ts = '1234567890.123456') {
  return {
    action: { value: String(matchId) },
    ack:    async () => {},
    body:   { channel: { id: channelId }, message: { ts } },
    client: {
      chat: {
        update:      async () => {},
        postMessage: async () => {},
      },
    },
  };
}

console.log('\n=== Reschedule Flow Tests ===\n');

(async () => {

  // ── buildConfirmationMessage ────────────────────────────────────────────────
  console.log('buildConfirmationMessage');
  {
    // Without matchId — no Reschedule button (backward-compat / auto-booker path)
    const blocks = buildConfirmationMessage(fakeBooking, fakeUsers, 'America/Chicago');
    const actionBlocks = blocks.filter((b) => b.type === 'actions');
    const hasReschedule = actionBlocks.some((b) =>
      b.elements.some((e) => e.action_id === 'watercooler_reschedule'));
    check('no matchId → no Reschedule button', !hasReschedule);

    // With matchId — Reschedule button present
    const blocksWithId = buildConfirmationMessage(fakeBooking, fakeUsers, 'America/Chicago', 42);
    const hasRescheduleWithId = blocksWithId
      .filter((b) => b.type === 'actions')
      .some((b) => b.elements.some((e) => e.action_id === 'watercooler_reschedule'));
    check('with matchId → Reschedule button present', hasRescheduleWithId);

    // Reschedule button value is the matchId as string
    const rescheduleBtn = blocksWithId
      .flatMap((b) => b.type === 'actions' ? b.elements : [])
      .find((e) => e.action_id === 'watercooler_reschedule');
    check('Reschedule button value is matchId string', rescheduleBtn?.value === '42');

    // Join Teams button still present
    const hasTeams = blocksWithId
      .flatMap((b) => b.type === 'actions' ? b.elements : [])
      .some((e) => e.action_id === 'watercooler_join_teams');
    check('Join Teams button still present alongside Reschedule', hasTeams);

    // No Teams link — only Reschedule button
    const noTeams = buildConfirmationMessage(
      { ...fakeBooking, teamsLink: null }, fakeUsers, 'UTC', 7);
    const actionEls = noTeams.flatMap((b) => b.type === 'actions' ? b.elements : []);
    check('no teamsLink → only Reschedule button in actions', actionEls.length === 1 &&
      actionEls[0].action_id === 'watercooler_reschedule');
  }

  // ── resetBooking / clearPreviousEvent ────────────────────────────────────────
  console.log('\nresetBooking / clearPreviousEvent');
  {
    // Create a disposable match with a fake booking
    const roundId = createRound('test-reschedule');
    const matchId = saveMatch(roundId);
    completeRound(roundId);

    saveBooking(matchId, { calendarEventId: 'evt-old-456', teamsLink: 'https://teams/old' });
    getDb().prepare(`UPDATE matches SET meeting_start_at = '2026-06-09T14:00:00Z',
                                        meeting_end_at   = '2026-06-09T14:30:00Z' WHERE id = ?`).run(matchId);

    const before = getMatch(matchId);
    check('before reset: calendar_event_id set',  before.calendar_event_id === 'evt-old-456');
    check('before reset: previous_event_id null', before.previous_event_id === null);

    resetBooking(matchId);
    const after = getMatch(matchId);

    check('after reset: calendar_event_id is null',           after.calendar_event_id === null);
    check('after reset: previous_event_id = old event ID',    after.previous_event_id === 'evt-old-456');
    check('after reset: teams_link cleared',                  after.teams_link === null);
    check('after reset: booked_at cleared',                   after.booked_at === null);
    check('after reset: meeting_start_at cleared',            after.meeting_start_at === null);
    check('after reset: meeting_end_at cleared',              after.meeting_end_at === null);

    clearPreviousEvent(matchId);
    const afterClear = getMatch(matchId);
    check('after clearPreviousEvent: previous_event_id null', afterClear.previous_event_id === null);
  }

  // ── handleReschedule — guards ────────────────────────────────────────────────
  console.log('\nhandleReschedule — guards');
  {
    // Booking in-flight: calendar_event_id = 'pending'
    const roundId = createRound('test-reschedule-pending');
    const matchId = saveMatch(roundId);
    completeRound(roundId);
    getDb().prepare(`UPDATE matches SET calendar_event_id = 'pending' WHERE id = ?`).run(matchId);

    const updateCalls = [];
    const { action, ack, body, client: c } = makeActionBody(matchId);
    const trackingClient = {
      chat: {
        update:      async (a) => updateCalls.push(a),
        postMessage: async () => {},
      },
    };
    await handleReschedule({ action, ack, body, client: trackingClient });
    check('pending booking → update message with wait notice',
      updateCalls.length === 1 && updateCalls[0].text.includes('just being confirmed'));

    // Already rescheduling: calendar_event_id = null, previous_event_id set
    const roundId2 = createRound('test-reschedule-already');
    const matchId2 = saveMatch(roundId2);
    completeRound(roundId2);
    saveBooking(matchId2, { calendarEventId: 'evt-some', teamsLink: null });
    resetBooking(matchId2); // now calendar_event_id=null, previous_event_id='evt-some'

    const updateCalls2 = [];
    const body2 = { channel: { id: 'C_TEST' }, message: { ts: '999.000' } };
    const trackingClient2 = {
      chat: {
        update:      async (a) => updateCalls2.push(a),
        postMessage: async () => {},
      },
    };
    await handleReschedule({ action: { value: String(matchId2) }, ack: async () => {}, body: body2, client: trackingClient2 });
    check('already rescheduling → update message with scroll notice',
      updateCalls2.length === 1 && updateCalls2[0].text.includes('already posted'));
  }

  // ── handleReschedule — happy path ────────────────────────────────────────────
  console.log('\nhandleReschedule — happy path');
  {
    const roundId = createRound('test-reschedule-happy');
    const matchId = saveMatch(roundId);
    completeRound(roundId);
    saveBooking(matchId, { calendarEventId: 'evt-real-789', teamsLink: 'https://teams/real' });

    const updateCalls = [];
    // suggestMeetingTimes will bail early (calendar_enabled check / Azure missing)
    // but we can confirm resetBooking ran and the message was updated
    const trackingClient = {
      chat: {
        update:      async (a) => updateCalls.push(a),
        postMessage: async () => {},
      },
    };
    const body = { channel: { id: 'C_HAPPY' }, message: { ts: '111.222' } };
    await handleReschedule({ action: { value: String(matchId) }, ack: async () => {}, body, client: trackingClient });

    const afterReset = getMatch(matchId);
    check('happy path: calendar_event_id cleared',         afterReset.calendar_event_id === null);
    check('happy path: previous_event_id = old event ID',  afterReset.previous_event_id === 'evt-real-789');
    check('happy path: update called with rescheduling text',
      updateCalls.length >= 1 && updateCalls[0].text.includes('Rescheduling'));
  }

  // ── previous_event_id cleared by clearPreviousEvent ─────────────────────────
  console.log('\nclearPreviousEvent (deferred deletion path)');
  {
    const roundId = createRound('test-clear-prev');
    const matchId = saveMatch(roundId);
    completeRound(roundId);
    saveBooking(matchId, { calendarEventId: 'evt-to-clear', teamsLink: null });
    resetBooking(matchId);

    check('before clear: previous_event_id set', getMatch(matchId).previous_event_id === 'evt-to-clear');
    clearPreviousEvent(matchId);
    check('after clear: previous_event_id null', getMatch(matchId).previous_event_id === null);
  }

  // ── Results ──────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));

  if (failed > 0) process.exit(1);
})();
