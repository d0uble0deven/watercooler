'use strict';

// "More times" tests
//
// The 3 starter suggestions get a "🗓️ More times" button that opens the
// private full list of open times — without ever resetting a booking. Booking
// from any private list then retires the match's previous public message (the
// starter suggestions, or the old confirmation after a reschedule) so stale
// buttons and old times don't linger next to the new confirmation.
// Starter button labels are also shorter, so Slack never truncates them.
//
// Run: npm run test:more-times
process.env.TZ = 'America/New_York';

const fs = require('node:fs');
const path = require('node:path');
const { initDb } = require('../src/db/init');
initDb();

// Simulated Graph + booking, in place before the handlers are required.
const msGraph = require('../src/integrations/msGraph');
let graph = null;
msGraph.getGraphClient = () => graph;
const calendarBooker = require('../src/integrations/calendarBooker');
let bookCount = 0;
calendarBooker.bookMeeting = async (graphClient, users, start, end) => ({
  eventId: `evt-more-${++bookCount}`, teamsLink: 'https://teams.microsoft.com/new', start, end,
});

const config = require('../src/config');
const { buildSuggestionsMessage, formatSlotLabel } = require('../src/integrations/calendarScheduler');
const { handleMoreTimes } = require('../src/commands/actions/moreTimes');
const { handleBookSlot } = require('../src/commands/actions/bookSlot');
const {
  createRound, saveMatch, saveMatchMembers, completeRound, updateMatchChannel,
  saveBooking, resetBooking, claimBooking, saveMeetingTimes, saveSuggestionTs, getMatch, getSettings,
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

async function section(title, fn) {
  console.log(`\n${title}`);
  try { await fn(); } catch (err) {
    console.error(`  ❌ section crashed: ${err.stack}`);
    failed++;
  }
}

function cleanup() {
  const db = getDb();
  db.exec(`DELETE FROM match_members WHERE match_id IN (
             SELECT m.id FROM matches m JOIN rounds r ON r.id = m.round_id
             WHERE r.created_by = 'test-moretimes')`);
  db.exec(`DELETE FROM matches WHERE round_id IN (SELECT id FROM rounds WHERE created_by = 'test-moretimes')`);
  db.exec(`DELETE FROM rounds WHERE created_by = 'test-moretimes'`);
  db.exec(`DELETE FROM users WHERE slack_user_id LIKE 'U_MORE_%'`);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Open calendars; records old-event deletions. */
function graphMock() {
  const deletes = [];
  return {
    deletes,
    api(url) {
      const req = {
        header() { return req; },
        async post(body) { return { value: body.schedules.map((e) => ({ scheduleId: e, scheduleItems: [] })) }; },
        async get() {
          if (url.includes('/mailboxSettings')) throw new Error('Access is denied');
          return { value: [] };
        },
        async delete() { deletes.push(url); },
      };
      return req;
    },
  };
}

/** Slack client that records everything, in order. */
function slackMock({ failPost = false, failUpdate = false } = {}) {
  const log = [];
  return {
    log,
    posts:      () => log.filter((e) => e.kind === 'post').map((e) => e.msg),
    updates:    () => log.filter((e) => e.kind === 'update').map((e) => e.msg),
    ephemerals: () => log.filter((e) => e.kind === 'ephemeral').map((e) => e.msg),
    responds:   () => log.filter((e) => e.kind === 'respond').map((e) => e.msg),
    client: { chat: {
      postMessage:   async (msg) => { log.push({ kind: 'post', msg }); if (failPost) throw new Error('channel_not_found'); return { ts: '9.9' }; },
      update:        async (msg) => { log.push({ kind: 'update', msg }); if (failUpdate) throw new Error('message_not_found'); return {}; },
      postEphemeral: async (msg) => { log.push({ kind: 'ephemeral', msg }); return {}; },
    } },
    respond: async (msg) => { log.push({ kind: 'respond', msg }); },
  };
}

let users;
function makeMatch({ suggestionTs = '111.1', booked = false, rescheduling = false, pending = false, meetingTimes = null } = {}) {
  const roundId = createRound('test-moretimes');
  const matchId = saveMatch(roundId);
  saveMatchMembers(matchId, [users.a.id, users.b.id]);
  updateMatchChannel(matchId, 'C_MORE');
  completeRound(roundId);
  if (suggestionTs) saveSuggestionTs(matchId, suggestionTs);
  if (booked || rescheduling) saveBooking(matchId, { calendarEventId: 'evt-old', teamsLink: 'https://teams/old' });
  if (meetingTimes) saveMeetingTimes(matchId, meetingTimes.start, meetingTimes.end);
  if (rescheduling) resetBooking(matchId);
  if (pending) claimBooking(matchId);
  return matchId;
}

const click = (matchId, userId = 'U_MORE_B') => ({
  action: { value: String(matchId), action_id: 'watercooler_more_times' },
  body:   { channel: { id: 'C_MORE' }, user: { id: userId }, container: { is_ephemeral: false } },
});
const slotButtons = (blocks) => (blocks ?? []).filter((b) => b.type === 'actions').flatMap((b) => b.elements)
  .filter((e) => /^watercooler_book_slot_\d+$/.test(e.action_id));
const bookingFields = (m) => ({ e: m.calendar_event_id, p: m.previous_event_id, s: m.meeting_start_at, ts: m.calendar_suggestion_ts });

console.log('\n=== More Times Tests ===');

(async () => {
  cleanup();
  const a = createUser('U_MORE_A', 'More A');
  const b = createUser('U_MORE_B', 'More B');
  saveUserEmail('U_MORE_A', 'more-a@example.test');
  saveUserEmail('U_MORE_B', 'more-b@example.test');
  users = { a, b };
  graph = graphMock();

  // ── The starter message ────────────────────────────────────────────────────
  await section('buildSuggestionsMessage() — starter message with More times', () => {
    const mk = (iso) => ({ start: new Date(iso), end: new Date(new Date(iso).getTime() + 15 * 60e3) });
    const slots = [mk('2026-11-18T17:30:00Z'), mk('2026-11-19T18:00:00Z'), mk('2026-11-25T16:00:00Z')];
    const blocks = buildSuggestionsMessage(slots, 42, 'America/New_York');

    check('layout: headline · slot row · More times row · footer',
      blocks.map((x) => x.type).join() === 'section,actions,actions,context', blocks.map((x) => x.type));
    const [slotRow, moreRow] = blocks.filter((x) => x.type === 'actions');
    check('slot row: the 3 green slot buttons, unchanged values',
      slotRow.elements.length === 3 && slotRow.elements.every((e) => e.style === 'primary') &&
      slotRow.elements[0].value === `${slots[0].start.toISOString()}|${slots[0].end.toISOString()}|42`);
    check('short labels: "Wed, Nov 18 · 12:30 PM", "Thu, Nov 19 · 1:00 PM", "Wed, Nov 25 · 11:00 AM"',
      slotRow.elements.map((e) => e.text.text).join(' | ') ===
        'Wed, Nov 18 · 12:30 PM | Thu, Nov 19 · 1:00 PM | Wed, Nov 25 · 11:00 AM',
      slotRow.elements.map((e) => e.text.text));

    const more = moreRow.elements;
    check('More times row: one button "🗓️ More times"', more.length === 1 && more[0].text.text === '🗓️ More times', more);
    check('More times: action_id watercooler_more_times, value = match ID',
      more[0].action_id === 'watercooler_more_times' && more[0].value === '42');
    check('More times is not green (the slots stay the main choice)', more[0].style === undefined);

    const footer = blocks[3].elements[0].text;
    check('footer: timezone + points to More times + only you will see them',
      footer.includes('All times in EST') && footer.includes('*More times*') && footer.includes('only you'), footer);
    check('test mode keeps its 🧪 note',
      JSON.stringify(buildSuggestionsMessage(slots, 42, 'America/New_York', true).at(-1)).includes('🧪'));
    check('summer → footer says EDT',
      buildSuggestionsMessage([mk('2026-07-15T17:00:00Z')], 42, 'America/New_York')[3].elements[0].text.includes('EDT'));

    // Every weekday × every half-hour × a long month name: never truncated.
    let longest = '';
    for (let d = 0; d < 7; d++) for (let h = 0; h < 16; h++) {
      const start = new Date(Date.UTC(2026, 8, 28 + d, 13 + Math.floor(h / 2), (h % 2) * 30));
      const label = buildSuggestionsMessage([{ start, end: start }], 1, 'America/New_York')[1].elements[0].text.text;
      if (label.length > longest.length) longest = label;
    }
    check(`longest label is ${longest.length} characters ("${longest}") — Slack truncates around 30`, longest.length <= 30);
  });

  // ── Clicking More times ────────────────────────────────────────────────────
  await section('handleMoreTimes() — not booked yet', async () => {
    const matchId = makeMatch();
    const before = bookingFields(getMatch(matchId));
    const s = slackMock();
    let acked = 0;
    await handleMoreTimes({ ...click(matchId), ack: async () => { acked++; }, client: s.client });

    check('acknowledges the click', acked === 1);
    check('sends the full list privately to whoever clicked',
      s.ephemerals().length === 1 && s.ephemerals()[0].user === 'U_MORE_B' && s.ephemerals()[0].channel === 'C_MORE',
      s.ephemerals().map((e) => e.user));
    check('it is the full list ("Pick any time that works", many times)',
      s.ephemerals()[0]?.blocks[0].text.text.includes('Pick any time that works') && slotButtons(s.ephemerals()[0]?.blocks).length > 3);
    check('nothing posted or edited publicly', s.posts().length === 0 && s.updates().length === 0);
    check('booking and starter message untouched', JSON.stringify(bookingFields(getMatch(matchId))) === JSON.stringify(before),
      bookingFields(getMatch(matchId)));

    const s2 = slackMock();
    await handleMoreTimes({ ...click(matchId, 'U_MORE_A'), ack: async () => {}, client: s2.client });
    check('either person can use it — the list goes to whoever clicked', s2.ephemerals()[0]?.user === 'U_MORE_A');
  });

  await section('handleMoreTimes() — mid-reschedule, booked, pending, bad input', async () => {
    const mid = makeMatch({ rescheduling: true });
    const s = slackMock();
    await handleMoreTimes({ ...click(mid), ack: async () => {}, client: s.client });
    check('mid-reschedule → shows the list', slotButtons(s.ephemerals()[0]?.blocks).length > 3);
    check('mid-reschedule → keeps the pointer to the old event (still deleted on rebook)',
      getMatch(mid).previous_event_id === 'evt-old' && getMatch(mid).calendar_event_id === null);

    const start = new Date('2026-11-24T15:00:00Z');
    const end = new Date('2026-11-24T15:15:00Z');
    const booked = makeMatch({ booked: true, meetingTimes: { start, end } });
    const beforeBooked = bookingFields(getMatch(booked));
    const s2 = slackMock();
    await handleMoreTimes({ ...click(booked), ack: async () => {}, client: s2.client });
    const note = s2.ephemerals()[0]?.text ?? '';
    const tz = getSettings()?.calendar_timezone || config.calendarTimezone;
    check(`booked → private note "already booked for *${formatSlotLabel({ start, end }, tz)}*"`,
      note.includes(`already booked for *${formatSlotLabel({ start, end }, tz)}*`), note);
    check('booked → points to Reschedule and /watercooler reschedule',
      note.includes('Reschedule') && note.includes('/watercooler reschedule'));
    check('booked → no list, nothing public, booking untouched',
      s2.ephemerals().length === 1 && slotButtons(s2.ephemerals()[0].blocks).length === 0 &&
      s2.posts().length === 0 && JSON.stringify(bookingFields(getMatch(booked))) === JSON.stringify(beforeBooked));

    const bookedNoTimes = makeMatch({ booked: true });
    const s3 = slackMock();
    await handleMoreTimes({ ...click(bookedNoTimes), ack: async () => {}, client: s3.client });
    check('booked without stored times → "already booked." (no time)',
      (s3.ephemerals()[0]?.text ?? '').startsWith('✅ This meeting is already booked. '), s3.ephemerals()[0]?.text);

    const pending = makeMatch({ pending: true });
    const s4 = slackMock();
    await handleMoreTimes({ ...click(pending), ack: async () => {}, client: s4.client });
    check('booking in progress → "please wait" note only',
      s4.ephemerals().length === 1 && s4.ephemerals()[0].text.includes('please wait') &&
      getMatch(pending).calendar_event_id === 'pending');

    for (const [label, args] of [
      ['bad button value', { action: { value: 'abc' }, body: click(1).body }],
      ['unknown match', click(999999)],
      ['no user on the click', { action: { value: String(pending) }, body: { channel: { id: 'C_MORE' } } }],
    ]) {
      const s5 = slackMock();
      let threw = false;
      let acked = 0;
      try { await handleMoreTimes({ ...args, ack: async () => { acked++; }, client: s5.client }); }
      catch { threw = true; }
      check(`${label} → acknowledged, nothing sent, no crash`, !threw && acked === 1 && s5.log.length === 0, s5.log);
    }
  });

  // ── Booking from a private list retires the previous public message ───────
  const value = (matchId, days = 3) => {
    const start = new Date(Date.now() + days * 86400e3);
    return `${start.toISOString()}|${new Date(start.getTime() + 15 * 60e3).toISOString()}|${matchId}`;
  };
  const privateClick = (matchId) => ({
    action: { value: value(matchId) },
    ack: async () => {},
    body: { channel: { id: 'C_MORE' }, user: { id: 'U_MORE_B' }, container: { is_ephemeral: true } },
  });

  await section('booking from the list — starter suggestions retired', async () => {
    const matchId = makeMatch({ suggestionTs: '111.1' });
    const s = slackMock();
    await handleBookSlot({ ...privateClick(matchId), client: s.client, respond: s.respond });

    check('confirmation posted publicly (partner notified)',
      s.posts().length === 1 && s.posts()[0].text.includes('Meeting booked'));
    const upd = s.updates();
    check('the starter message is replaced', upd.length === 1 && upd[0].ts === '111.1' && upd[0].channel === 'C_MORE', upd);
    check('…with "✅ Booked — see the confirmation below."', upd[0]?.text === '✅ _Booked — see the confirmation below._', upd[0]?.text);
    check('…and no buttons left on it (slots + More times gone)',
      upd[0]?.blocks.every((x) => x.type !== 'actions'), upd[0]?.blocks);
    check('confirmation is posted BEFORE the old message is touched',
      s.log.findIndex((e) => e.kind === 'post') < s.log.findIndex((e) => e.kind === 'update'));
    check('the new confirmation is now the tracked message', getMatch(matchId).calendar_suggestion_ts === '9.9');
    check('private list cleared', s.responds().some((r) => r.replace_original === true));
    check('booked', getMatch(matchId).calendar_event_id?.startsWith('evt-more-'));
  });

  await section('booking from the list — after a reschedule, the old confirmation is retired', async () => {
    graph = graphMock();
    const matchId = makeMatch({ suggestionTs: '222.2', rescheduling: true });
    const s = slackMock();
    await handleBookSlot({ ...privateClick(matchId), client: s.client, respond: s.respond });
    const upd = s.updates();
    check('old confirmation replaced with "🔄 This meeting was rescheduled — see the new time below."',
      upd.length === 1 && upd[0].ts === '222.2' && upd[0].text === '🔄 _This meeting was rescheduled — see the new time below._', upd);
    check('old calendar event still deleted', graph.deletes.some((u) => u.includes('evt-old')), graph.deletes);
    check('new confirmation tracked', getMatch(matchId).calendar_suggestion_ts === '9.9');
  });

  await section('booking from the list — edge cases', async () => {
    const noTs = makeMatch({ suggestionTs: null });
    const s = slackMock();
    await handleBookSlot({ ...privateClick(noTs), client: s.client, respond: s.respond });
    check('no previous message on record → nothing edited', s.updates().length === 0, s.updates());
    check('…new confirmation tracked', getMatch(noTs).calendar_suggestion_ts === '9.9');

    const postFails = makeMatch({ suggestionTs: '333.3' });
    const s2 = slackMock({ failPost: true });
    await handleBookSlot({ ...privateClick(postFails), client: s2.client, respond: s2.respond });
    check('confirmation post fails → the starter message is NOT retired (no lost buttons)',
      s2.updates().length === 0 && getMatch(postFails).calendar_suggestion_ts === '333.3');
    check('…booking still saved', getMatch(postFails).calendar_event_id?.startsWith('evt-more-'));

    const updateFails = makeMatch({ suggestionTs: '444.4' });
    const s3 = slackMock({ failUpdate: true });
    let threw = false;
    try { await handleBookSlot({ ...privateClick(updateFails), client: s3.client, respond: s3.respond }); }
    catch { threw = true; }
    check('retiring fails (message deleted?) → no crash, booking kept, list still cleared, new ts tracked',
      !threw && getMatch(updateFails).calendar_event_id?.startsWith('evt-more-') &&
      s3.responds().some((r) => r.replace_original === true) && getMatch(updateFails).calendar_suggestion_ts === '9.9');

    const pub = makeMatch({ suggestionTs: '555.5' });
    const s4 = slackMock();
    await handleBookSlot({
      action: { value: value(pub) }, ack: async () => {},
      body: { channel: { id: 'C_MORE' }, user: { id: 'U_MORE_B' }, message: { ts: '555.5' }, container: { is_ephemeral: false } },
      client: s4.client, respond: s4.respond,
    });
    check('booking from the starter buttons themselves → unchanged: confirmation replaces that message',
      s4.updates().length === 1 && s4.updates()[0].ts === '555.5' && s4.updates()[0].text === '✅ Meeting booked!' &&
      s4.posts().length === 0, s4.log.map((e) => e.kind));
  });

  await section('wiring', () => {
    const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
    check("app.js registers 'watercooler_more_times' → handleMoreTimes",
      /app\.action\('watercooler_more_times',\s*handleMoreTimes\)/.test(app));
  });

  cleanup();
  graph = null;
  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Test run crashed:', err);
  cleanup();
  process.exit(1);
});
