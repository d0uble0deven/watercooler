'use strict';

// Phase 10 Step 6 — Booking unit tests
//
// Tests the pure helpers in calendarBooker (buildConfirmationMessage,
// buildAlreadyBookedMessage, buildEventBodyHtml) and the Graph API payload
// shape via a mock client. No Azure credentials or Slack tokens required.
//
// Run: npm run test:step6

const {
  bookMeeting,
  buildConfirmationMessage,
  buildAlreadyBookedMessage,
  buildEventBodyHtml,
} = require('../src/integrations/calendarBooker');

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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ALICE = { id: 1, slack_user_id: 'UALICE0', display_name: 'Alice', slack_email: 'alice@docme360.com' };
const BOB   = { id: 2, slack_user_id: 'UBOB000', display_name: 'Bob',   slack_email: 'bob@docme360.com'   };
const CAROL = { id: 3, slack_user_id: 'UCAROL0', display_name: 'Carol', slack_email: 'carol@docme360.com' };

const SLOT_START = new Date('2025-06-09T09:00:00Z');
const SLOT_END   = new Date('2025-06-09T09:30:00Z');
const TEAMS_LINK = 'https://teams.microsoft.com/l/meetup-join/fake-link';

// Mock Graph client that captures what was posted
function mockClient(eventResponse = {}) {
  let capturedPath = null;
  let capturedBody = null;

  const client = {
    api: (path) => {
      capturedPath = path;
      return {
        post: async (body) => {
          capturedBody = body;
          return {
            id: 'AAMkAGE1234',
            onlineMeeting: { joinUrl: TEAMS_LINK },
            ...eventResponse,
          };
        },
      };
    },
    _getCaptured: () => ({ path: capturedPath, body: capturedBody }),
  };
  return client;
}

function errorClient(message) {
  return {
    api: () => ({ post: async () => { throw new Error(message); } }),
  };
}

console.log('\n=== Phase 10 — Step 6: Calendar Booking Tests ===\n');

// ── buildEventBodyHtml ────────────────────────────────────────────────────────
console.log('buildEventBodyHtml()');
{
  const html = buildEventBodyHtml([ALICE, BOB]);
  check('returns a string',                   typeof html === 'string', typeof html);
  check('mentions Watercooler',               html.includes('Watercooler'), html);
  check('mentions participant names',         html.includes('Alice') && html.includes('Bob'), html);
  check('is valid HTML (has <p> tags)',       html.includes('<p>'), html);

  // Trio
  const htmlTrio = buildEventBodyHtml([ALICE, BOB, CAROL]);
  check('trio includes all three names',      htmlTrio.includes('Alice') && htmlTrio.includes('Carol'), htmlTrio);
}

// ── bookMeeting — Graph API payload ──────────────────────────────────────────
console.log('\nbookMeeting() — Graph API call shape');
{
  (async () => {
    const client  = mockClient();
    const booking = await bookMeeting(client, [ALICE, BOB], SLOT_START, SLOT_END);
    const { path, body } = client._getCaptured();

    check('calls /users/{organizer-email}/events endpoint',
      // encodeURIComponent encodes @ as %40 — that is correct behaviour
      path?.includes('alice%40docme360.com') && path?.includes('/events'), path);

    check('subject contains both names',     body?.subject?.includes('Alice') && body?.subject?.includes('Bob'), body?.subject);
    check('start dateTime is UTC',           body?.start?.timeZone === 'UTC', body?.start?.timeZone);
    check('end dateTime is UTC',             body?.end?.timeZone   === 'UTC', body?.end?.timeZone);
    check('isOnlineMeeting is true',         body?.isOnlineMeeting === true, body?.isOnlineMeeting);
    check('onlineMeetingProvider is Teams',  body?.onlineMeetingProvider === 'teamsForBusiness', body?.onlineMeetingProvider);
    check('attendees contains Alice',        body?.attendees?.some((a) => a.emailAddress.address === 'alice@docme360.com'));
    check('attendees contains Bob',          body?.attendees?.some((a) => a.emailAddress.address === 'bob@docme360.com'));
    check('attendee type is required',       body?.attendees?.every((a) => a.type === 'required'));
    check('body has HTML contentType',       body?.body?.contentType === 'HTML', body?.body?.contentType);
    check('start encodes slot start',        body?.start?.dateTime?.startsWith('2025-06-09T09:00:00'), body?.start?.dateTime);
    check('end encodes slot end',            body?.end?.dateTime?.startsWith('2025-06-09T09:30:00'), body?.end?.dateTime);
  })().catch((e) => { console.error('  ❌ Async test failed:', e.message); failed++; });
}

// ── bookMeeting — return value ────────────────────────────────────────────────
console.log('\nbookMeeting() — return value');
{
  (async () => {
    const booking = await bookMeeting(mockClient(), [ALICE, BOB], SLOT_START, SLOT_END);
    check('returns eventId',                 typeof booking.eventId === 'string', booking.eventId);
    check('returns teamsLink',               booking.teamsLink === TEAMS_LINK, booking.teamsLink);
    check('returns start Date',              booking.start instanceof Date, typeof booking.start);
    check('returns end Date',               booking.end instanceof Date, typeof booking.end);
    check('start matches slot start',        booking.start.getTime() === SLOT_START.getTime());
  })().catch((e) => { console.error('  ❌ Async test failed:', e.message); failed++; });
}

// ── bookMeeting — no Teams link graceful ─────────────────────────────────────
console.log('\nbookMeeting() — no Teams link (tenant without Teams)');
{
  (async () => {
    // Simulate event created but no onlineMeeting in response
    const noTeamsClient = mockClient({ onlineMeeting: null });
    const booking = await bookMeeting(noTeamsClient, [ALICE, BOB], SLOT_START, SLOT_END);
    check('teamsLink is null when missing',  booking.teamsLink === null, booking.teamsLink);
  })().catch((e) => { console.error('  ❌ Async test failed:', e.message); failed++; });
}

// ── bookMeeting — error propagates ───────────────────────────────────────────
console.log('\nbookMeeting() — Graph API error propagates to caller');
{
  (async () => {
    let threw = false;
    try {
      await bookMeeting(errorClient('Forbidden'), [ALICE, BOB], SLOT_START, SLOT_END);
    } catch (_) {
      threw = true;
    }
    check('throws on Graph API error',       threw);
  })().catch((e) => { console.error('  ❌ Async test failed:', e.message); failed++; });
}

// ── buildConfirmationMessage ──────────────────────────────────────────────────
console.log('\nbuildConfirmationMessage()');
{
  const booking = { start: SLOT_START, end: SLOT_END, teamsLink: TEAMS_LINK };
  const blocks  = buildConfirmationMessage(booking, [ALICE, BOB], 'UTC');

  check('returns an array',                  Array.isArray(blocks), typeof blocks);

  const section = blocks.find((b) => b.type === 'section');
  check('has section block',                 !!section);
  check('section shows ✅ booked',           section?.text?.text?.includes('✅'), section?.text?.text);
  check('section shows participant names',   section?.text?.text?.includes('Alice') && section?.text?.text?.includes('Bob'));
  check('section shows meeting time',        section?.text?.text?.includes('Jun'), section?.text?.text);

  const actions = blocks.find((b) => b.type === 'actions');
  check('has Teams button when link present', !!actions);
  check('Teams button has correct action_id', actions?.elements?.[0]?.action_id === 'watercooler_join_teams', actions?.elements?.[0]?.action_id);
  check('Teams button URL is set',            actions?.elements?.[0]?.url === TEAMS_LINK, actions?.elements?.[0]?.url);

  const context = blocks.find((b) => b.type === 'context');
  check('has context block',                 !!context);
  check('context mentions calendar invite',  context?.elements?.[0]?.text?.includes('calendar invite'), context?.elements?.[0]?.text);

  // Without Teams link — no actions block
  const noTeams = buildConfirmationMessage({ start: SLOT_START, end: SLOT_END, teamsLink: null }, [ALICE], 'UTC');
  check('no actions block when teamsLink is null', !noTeams.some((b) => b.type === 'actions'));
}

// ── buildAlreadyBookedMessage ─────────────────────────────────────────────────
console.log('\nbuildAlreadyBookedMessage()');
{
  const blocks  = buildAlreadyBookedMessage(TEAMS_LINK);
  check('returns an array',                  Array.isArray(blocks));

  const section = blocks.find((b) => b.type === 'section');
  check('section mentions already booked',   section?.text?.text?.includes('already been booked'), section?.text?.text);

  const actions = blocks.find((b) => b.type === 'actions');
  check('has Teams button',                  !!actions);
  check('Teams button URL matches link',     actions?.elements?.[0]?.url === TEAMS_LINK, actions?.elements?.[0]?.url);

  // Without link
  const noLink = buildAlreadyBookedMessage(null);
  check('no actions block without link',     !noLink.some((b) => b.type === 'actions'));
}

// ── Button value parsing ──────────────────────────────────────────────────────
console.log('\nButton value encoding / parsing');
{
  // Simulate what buildSuggestionsMessage encodes, then parse it
  const matchId   = 99;
  const btnValue  = `${SLOT_START.toISOString()}|${SLOT_END.toISOString()}|${matchId}`;
  const [s, e, m] = btnValue.split('|');

  check('startIso round-trips correctly',  new Date(s).getTime() === SLOT_START.getTime(), s);
  check('endIso round-trips correctly',    new Date(e).getTime() === SLOT_END.getTime(), e);
  check('matchId round-trips correctly',   parseInt(m, 10) === matchId, m);
  check('exactly 3 pipe-delimited parts',  btnValue.split('|').length === 3, btnValue);
}

// ── Results ───────────────────────────────────────────────────────────────────
// Give async tests a tick to settle
setTimeout(() => {
  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));
  if (failed > 0) process.exit(1);
}, 100);
