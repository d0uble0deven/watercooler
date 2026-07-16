'use strict';

// Booking privacy tests — the handoff from private reschedule back to public.
//
// The reschedule flow shows slot options ephemerally (only the requester sees
// them). This suite verifies the moment that privacy ENDS: when a slot is
// actually booked, the match partner MUST be notified via a public message.
// A regression here would mean someone silently reschedules and their partner
// never finds out — the worst possible failure for this feature.
//
// Also verifies the public path (initial round suggestion) still updates the
// original message in place, unchanged.
//
// Run: npm run test:booking-privacy

const { initDb } = require('../src/db/init');
initDb();

// ── Patch Graph + booking BEFORE requiring bookSlot (it destructures at load) ──
const msGraph = require('../src/integrations/msGraph');
msGraph.getGraphClient = () => ({
  api: () => ({ delete: async () => {} }), // old-event deletion on reschedule
});

const calendarBooker = require('../src/integrations/calendarBooker');
calendarBooker.bookMeeting = async (graphClient, users, start, end) => ({
  eventId:   'evt-newly-booked',
  teamsLink: 'https://teams.microsoft.com/new',
  start,
  end,
});

const { handleBookSlot } = require('../src/commands/actions/bookSlot');

const {
  createRound, saveMatch, saveMatchMembers, completeRound, updateMatchChannel,
  saveBooking, resetBooking, getMatch, getSettings, updateSettings,
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
             WHERE r.created_by = 'test-privacy')`);
  db.exec(`DELETE FROM matches WHERE round_id IN (SELECT id FROM rounds WHERE created_by = 'test-privacy')`);
  db.exec(`DELETE FROM rounds WHERE created_by = 'test-privacy'`);
  db.exec(`DELETE FROM users WHERE slack_user_id LIKE 'U_PRIV_%'`);
}

// Slot button payload: "<ISO start>|<ISO end>|<matchId>"
function slotValue(matchId) {
  const start = new Date(Date.now() + 3 * 86400000);
  const end   = new Date(start.getTime() + 15 * 60000);
  return `${start.toISOString()}|${end.toISOString()}|${matchId}`;
}

function makeTracker() {
  const publicPosts = [];
  const updates     = [];
  const responds    = [];
  return {
    publicPosts, updates, responds,
    client: {
      chat: {
        postMessage:   async (m) => { publicPosts.push(m); return { ts: '9.9' }; },
        update:        async (m) => { updates.push(m); },
        postEphemeral: async () => {},
      },
    },
    respond: async (payload) => { responds.push(payload); },
  };
}

console.log('\n=== Booking Privacy Tests ===\n');

const originalSettings = getSettings();

(async () => {
  cleanup();
  updateSettings({ calendar_enabled: 1 });

  const u1 = createUser('U_PRIV_1', 'Rae Requester');
  const u2 = createUser('U_PRIV_2', 'Pat Partner');
  saveUserEmail('U_PRIV_1', 'rae@example.test');
  saveUserEmail('U_PRIV_2', 'pat@example.test');

  function makeMatch(booked = false) {
    const roundId = createRound('test-privacy');
    const matchId = saveMatch(roundId);
    saveMatchMembers(matchId, [u1.id, u2.id]);
    updateMatchChannel(matchId, 'C_PRIV');
    completeRound(roundId);
    if (booked) {
      saveBooking(matchId, { calendarEventId: 'evt-old', teamsLink: 'https://teams/old' });
      resetBooking(matchId); // mid-reschedule: previous_event_id = 'evt-old'
    }
    return matchId;
  }

  // ── THE critical case: booking from private options notifies the partner ────
  console.log('booking from EPHEMERAL options (private reschedule)');
  {
    const matchId = makeMatch(true);
    const t = makeTracker();

    await handleBookSlot({
      action: { value: slotValue(matchId) },
      ack:    async () => {},
      body:   {
        channel:   { id: 'C_PRIV' },
        user:      { id: 'U_PRIV_1' },
        container: { is_ephemeral: true },
        // NOTE: no body.message — ephemeral payloads may omit it entirely.
      },
      client:  t.client,
      respond: t.respond,
    });

    check('posts the confirmation PUBLICLY (partner is notified)',
      t.publicPosts.length === 1 && t.publicPosts[0].channel === 'C_PRIV', t.publicPosts.length);
    check('public confirmation says "Meeting booked"',
      t.publicPosts[0]?.text.includes('Meeting booked'), t.publicPosts[0]?.text);
    check('public confirmation carries blocks (Teams link / reschedule button)',
      Array.isArray(t.publicPosts[0]?.blocks) && t.publicPosts[0].blocks.length > 0);
    check('never calls chat.update (no ts to update on an ephemeral)',
      t.updates.length === 0, t.updates);
    check('clears the requester\'s private options',
      t.responds.some((r) => r.replace_original === true), t.responds);
    check('booking persisted to DB', getMatch(matchId).calendar_event_id === 'evt-newly-booked');
    check('old event cleared after deletion', getMatch(matchId).previous_event_id === null);
  }

  // ── Public path unchanged (initial round suggestion) ────────────────────────
  console.log('\nbooking from PUBLIC options (initial round suggestion)');
  {
    const matchId = makeMatch(false);
    const t = makeTracker();

    await handleBookSlot({
      action: { value: slotValue(matchId) },
      ack:    async () => {},
      body:   {
        channel:   { id: 'C_PRIV' },
        user:      { id: 'U_PRIV_1' },
        message:   { ts: '123.456' },
        container: { is_ephemeral: false },
      },
      client:  t.client,
      respond: t.respond,
    });

    check('updates the original message in place', t.updates.length === 1, t.updates.length);
    check('update targets the clicked message ts', t.updates[0]?.ts === '123.456');
    check('does NOT post a duplicate public message', t.publicPosts.length === 0, t.publicPosts);
    check('booking persisted to DB', getMatch(matchId).calendar_event_id === 'evt-newly-booked');
  }

  // ── Race guard from a private flow stays private ─────────────────────────────
  console.log('\nalready-booked race, clicked from ephemeral options');
  {
    const matchId = makeMatch(false);
    saveBooking(matchId, { calendarEventId: 'evt-someone-else', teamsLink: 'https://teams/other' });

    const t = makeTracker();
    await handleBookSlot({
      action: { value: slotValue(matchId) },
      ack:    async () => {},
      body:   {
        channel:   { id: 'C_PRIV' },
        user:      { id: 'U_PRIV_1' },
        container: { is_ephemeral: true },
      },
      client:  t.client,
      respond: t.respond,
    });

    check('tells the clicker privately', t.responds.some((r) => r.text?.includes('already been booked')), t.responds);
    check('does not disturb the shared DM', t.publicPosts.length === 0 && t.updates.length === 0);
    check('existing booking untouched', getMatch(matchId).calendar_event_id === 'evt-someone-else');
  }

  // ── Restore + results ───────────────────────────────────────────────────────
  cleanup();
  updateSettings({ calendar_enabled: originalSettings.calendar_enabled });

  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));

  if (failed > 0) process.exit(1);
})();
