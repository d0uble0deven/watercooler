'use strict';

// Private full list of times ("browse" mode) tests
//
// Reschedule (and the decline nudge) used to show 9 hand-picked options.
// Now they show EVERY open half-hour start from ~30 minutes from now until
// the round ends — grouped by week and day, first two weeks with open times,
// visible only to the person who asked.
//
// Pinned to the VM's timezone so day/week grouping is deterministic.
process.env.TZ = 'America/New_York';
//
// Run: npm run test:browse-times

const { initDb } = require('../src/db/init');
initDb();

// Simulated Graph for the whole file (calendarScheduler destructures it at require time).
const msGraph = require('../src/integrations/msGraph');
let graph = null;
msGraph.getGraphClient = () => graph;

const scheduler = require('../src/integrations/calendarScheduler');
const { suggestMeetingTimes, buildBrowseMessage, pickBrowseWeeks } = scheduler;

// Record what reschedule.js passes to suggestMeetingTimes (it destructures at require time).
const realSuggest  = scheduler.suggestMeetingTimes;
const suggestCalls = [];
scheduler.suggestMeetingTimes = async (...args) => { suggestCalls.push(args); return realSuggest(...args); };
const { postPrivateTimeOptions, performReschedule } = require('../src/commands/actions/reschedule');
scheduler.suggestMeetingTimes = realSuggest;

const { getRoundEndDate } = require('../src/lib/roundSchedule');
const { zonedTime, localDateKey, addDaysToKey } = require('../src/lib/timezone');
const {
  createRound, saveMatch, saveMatchMembers, completeRound, updateMatchChannel,
  getMatch, getRoundById, getSettings, saveBooking,
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
             WHERE r.created_by = 'test-browse')`);
  db.exec(`DELETE FROM matches WHERE round_id IN (SELECT id FROM rounds WHERE created_by = 'test-browse')`);
  db.exec(`DELETE FROM rounds WHERE created_by = 'test-browse'`);
  db.exec(`DELETE FROM users WHERE slack_user_id LIKE 'U_BROWSE_%'`);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ET = 'America/New_York';
const MIN = 60e3;
const DAY = 24 * 3600e3;
const A = 'browse-a@example.test';
const B = 'browse-b@example.test';
const PTO = 'pto@docme360.com';

/** A 15-minute slot starting at hh:mm Eastern on dayKey. */
function slotAt(dayKey, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const start = zonedTime(dayKey, h, m, ET);
  return { start, end: new Date(start.getTime() + 15 * MIN) };
}
/** Every half-hour start 9:00–4:30 on dayKey (16 slots). */
function fullDay(dayKey) {
  return Array.from({ length: 16 }, (_, i) => slotAt(dayKey, `${9 + Math.floor(i / 2)}:${i % 2 ? '30' : '00'}`));
}
const at = (dayKey, hhmm = '00:00') => slotAt(dayKey, hhmm).start;

const buttonsOf = (blocks) => (blocks ?? []).filter((b) => b.type === 'actions').flatMap((b) => b.elements);
const textOf = (blocks) => JSON.stringify(blocks ?? []);
const valueStart = (btn) => new Date(btn.value.split('|')[0]);

/**
 * Simulated Graph: getSchedule (POST) answers from `schedules`, calendarView
 * (GET) from `calendars`, mailboxSettings is denied like on prod.
 */
function graphMock({ schedules = {}, calendars = {} } = {}) {
  return {
    api(url) {
      const req = {
        header() { return req; },
        async post(body) {
          return { value: body.schedules.map((email) => ({ scheduleId: email, scheduleItems: schedules[email] ?? [] })) };
        },
        async get() {
          if (url.includes('/mailboxSettings')) throw new Error('Access is denied');
          const email = decodeURIComponent(url.match(/\/users\/([^/]+)\/calendarView/)[1]);
          return { value: calendars[email] ?? [] };
        },
      };
      return req;
    },
  };
}
const schedItem = (start, end, status = 'busy') => ({
  status,
  start: { dateTime: start.toISOString().replace('Z', ''), timeZone: 'UTC' },
  end:   { dateTime: end.toISOString().replace('Z', ''), timeZone: 'UTC' },
});
/** A's own PTO (all-day, marked Free) covering [fromKey, toKey). */
const ownPto = (fromKey, toKey) => ({
  organizer: { emailAddress: { address: A } }, isOrganizer: true, isAllDay: true, isCancelled: false, showAs: 'free',
  start: { dateTime: `${fromKey}T00:00:00.0000000`, timeZone: 'UTC' },
  end:   { dateTime: `${toKey}T00:00:00.0000000`, timeZone: 'UTC' },
  attendees: [{ emailAddress: { address: PTO } }],
});

const slackClient = () => {
  const posts = [];
  const ephemerals = [];
  return { posts, ephemerals, chat: {
    postMessage:   async (m) => { posts.push(m); return { ts: '9.9' }; },
    postEphemeral: async (m) => { ephemerals.push(m); return {}; },
  } };
};

const usersAB = [
  { slack_user_id: 'U_BROWSE_A', display_name: 'A', slack_email: A, ms_timezone: null },
  { slack_user_id: 'U_BROWSE_B', display_name: 'B', slack_email: B, ms_timezone: null },
];
const settings = { calendar_enabled: 1, meeting_duration: 15, calendar_timezone: ET };

console.log('\n=== Private Full List (browse) Tests ===');

(async () => {
  cleanup();

  // ── Grouping into weeks ────────────────────────────────────────────────────
  await section('pickBrowseWeeks() — which weeks and days to show', () => {
    const weeks = (seq) => seq.map((e) => `${e.type}:${e.weekKey}`);
    const range = [at('2026-11-16', '10:30'), at('2026-12-07', '09:00')]; // Mon Nov 16 → round ends Dec 7

    const one = pickBrowseWeeks([slotAt('2026-11-17', '09:00'), slotAt('2026-11-17', '14:30'), slotAt('2026-11-18', '11:00')],
      ...range, ET, 2);
    check('slots on Tue + Wed → one week, two days',
      one.length === 1 && one[0].days.length === 2 && one[0].days[0].dayKey === '2026-11-17' &&
      one[0].days[0].slots.length === 2 && one[0].days[1].dayKey === '2026-11-18', one);

    const three = pickBrowseWeeks([slotAt('2026-11-17', '09:00'), slotAt('2026-11-24', '09:00'), slotAt('2026-12-01', '09:00')],
      ...range, ET, 2);
    check('open times in 3 weeks → only the first 2 shown',
      weeks(three).join() === 'week:2026-11-16,week:2026-11-23', weeks(three));

    const gap = pickBrowseWeeks([slotAt('2026-11-17', '09:00'), slotAt('2026-12-01', '09:00')], ...range, ET, 2);
    check('empty week in between (e.g. PTO) → noted as skipped, then the next open week',
      weeks(gap).join() === 'week:2026-11-16,skipped:2026-11-23,week:2026-11-30', weeks(gap));

    const late = pickBrowseWeeks([slotAt('2026-11-24', '09:00')], at('2026-11-18', '16:30'), range[1], ET, 2);
    check('nothing left this week → "this week" noted as skipped first',
      weeks(late).join() === 'skipped:2026-11-16,week:2026-11-23', weeks(late));

    const weekend = pickBrowseWeeks([slotAt('2026-11-24', '09:00')], at('2026-11-21', '11:00'), range[1], ET, 2);
    check('asked on a Saturday → no "nothing left this week" note',
      weeks(weekend).join() === 'week:2026-11-23', weeks(weekend));

    const trailing = pickBrowseWeeks([slotAt('2026-11-17', '09:00')], ...range, ET, 2);
    check('empty weeks after the last open one → not mentioned', weeks(trailing).join() === 'week:2026-11-16', weeks(trailing));

    check('no open times at all → nothing to show', pickBrowseWeeks([], ...range, ET, 2).length === 0);
  });

  // ── The message ────────────────────────────────────────────────────────────
  await section('buildBrowseMessage() — what the person sees', () => {
    const now = at('2026-11-16', '10:00');
    const seq = pickBrowseWeeks([...fullDay('2026-11-17').slice(0, 3), slotAt('2026-12-01', '13:30')],
      at('2026-11-16', '10:30'), at('2026-12-07', '09:00'), ET, 2);
    const blocks = buildBrowseMessage(seq, 42, ET, { now });
    const t = textOf(blocks);

    check('intro says every time is shown in EST', blocks[0].text.text.includes('*Pick any time that works* — all times EST'),
      blocks[0].text.text);
    check('intro says only you can see it', blocks[0].text.text.includes('Only you can see this'));
    check('"This week · Nov 16–20" header', blocks.some((b) => b.type === 'header' && b.text.text === 'This week · Nov 16–20'));
    check('skipped week noted: "No shared times the week of Nov 23."', t.includes('No shared times the week of Nov 23.'));
    check('"Week of Nov 30 · Nov 30 – Dec 4" header (across months)',
      blocks.some((b) => b.type === 'header' && b.text.text === 'Week of Nov 30 · Nov 30 – Dec 4'), t);
    check('day row label "*Tue, Nov 17*"', blocks.some((b) => b.type === 'section' && b.text.text === '*Tue, Nov 17*'));

    const btns = buttonsOf(blocks);
    check('buttons show only the time ("9:00 AM", "9:30 AM", …)',
      btns.map((b) => b.text.text).join() === '9:00 AM,9:30 AM,10:00 AM,1:30 PM', btns.map((b) => b.text.text));
    check('buttons are plain (not green)', btns.every((b) => b.style === undefined));
    check('every button uses the booking handler\'s action_id pattern',
      btns.every((b) => /^watercooler_book_slot_\d+$/.test(b.action_id)));
    check('action_ids are unique', new Set(btns.map((b) => b.action_id)).size === btns.length);
    check('button value = "<start>|<end>|<matchId>" like the starter buttons',
      btns[0].value === `${slotAt('2026-11-17', '09:00').start.toISOString()}|${slotAt('2026-11-17', '09:00').end.toISOString()}|42`,
      btns[0].value);

    const nextWeekSeq = pickBrowseWeeks([slotAt('2026-11-24', '09:00')], at('2026-11-18', '16:30'), at('2026-12-07', '09:00'), ET, 2);
    const nw = buildBrowseMessage(nextWeekSeq, 42, ET, { now: at('2026-11-18', '16:00') });
    check('"No shared times left this week." then "Next week · Nov 23–27"',
      nw[1].type === 'context' && nw[1].elements[0].text === '_No shared times left this week._' &&
      nw[2].type === 'header' && nw[2].text.text === 'Next week · Nov 23–27', nw.slice(1, 3));

    const central = buildBrowseMessage(pickBrowseWeeks([slotAt('2026-11-17', '09:00')],
      at('2026-11-16', '10:30'), at('2026-12-07', '09:00'), 'America/Chicago', 2), 42, 'America/Chicago', { now });
    check('Central display → "8:00 AM" and CST', buttonsOf(central)[0].text.text === '8:00 AM' && central[0].text.text.includes('CST'));

    const test = buildBrowseMessage(seq, 42, ET, { now, testMode: true });
    check('test mode adds the 🧪 note at the end', test[test.length - 1].type === 'context' && textOf([test[test.length - 1]]).includes('🧪'));

    const roundEnd = at('2026-12-07', '09:00');
    const FOOTER = "_That's everything before this round wraps up on Mon, Dec 7._";
    const full = buildBrowseMessage(seq, 42, ET, { now, roundEnd, complete: true });
    check('everything shown + round end known → closing line "That\'s everything before this round wraps up on Mon, Dec 7."',
      full[full.length - 1].type === 'context' && full[full.length - 1].elements[0].text === FOOTER, full[full.length - 1]);
    check('list cut off at two weeks → no closing line',
      !textOf(buildBrowseMessage(seq, 42, ET, { now, roundEnd, complete: false })).includes("That's everything"));
    check('no round end (two-week fallback) → no closing line',
      !textOf(buildBrowseMessage(seq, 42, ET, { now, complete: true })).includes("That's everything"));
    const both = buildBrowseMessage(seq, 42, ET, { now, roundEnd, complete: true, testMode: true });
    check('closing line comes before the 🧪 note',
      both[both.length - 2].elements?.[0].text === FOOTER && textOf([both[both.length - 1]]).includes('🧪'));
  });

  await section('buildBrowseMessage() — Slack limits with two completely open weeks', () => {
    const days = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20',
                  '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27'];
    const seq = pickBrowseWeeks(days.flatMap(fullDay), at('2026-11-16', '08:30'), at('2026-12-07', '09:00'), ET, 2);
    const blocks = buildBrowseMessage(seq, 7, ET, { now: at('2026-11-16', '08:00'), testMode: true });
    const btns = buttonsOf(blocks);
    check(`160 buttons (16 a day × 10 days) in ${blocks.length} blocks — Slack allows 50`, btns.length === 160 && blocks.length <= 50,
      { buttons: btns.length, blocks: blocks.length });
    check('every row ≤ 25 buttons (Slack limit)', blocks.filter((b) => b.type === 'actions').every((b) => b.elements.length <= 25));
    check('every header ≤ 150 characters (Slack limit)', blocks.filter((b) => b.type === 'header').every((b) => b.text.text.length <= 150));
    check('160 unique action_ids', new Set(btns.map((b) => b.action_id)).size === 160);
    check('one row per day', blocks.filter((b) => b.type === 'actions').length === 10);
  });

  // ── End to end through suggestMeetingTimes ─────────────────────────────────
  const roundId = createRound('test-browse');
  const matchId = saveMatch(roundId);
  updateMatchChannel(matchId, 'C_BROWSE');
  completeRound(roundId);

  await section('suggestMeetingTimes({ browse }) — open calendars', async () => {
    graph = graphMock();
    const before = Date.now();
    const roundEnd = new Date(before + 10 * DAY);
    const slack = slackClient();
    await suggestMeetingTimes(slack, 'C_BROWSE', matchId, usersAB, settings, false,
      { browse: true, privateToUserId: 'U_BROWSE_A', roundEnd });

    check('one private message, to the requester only',
      slack.ephemerals.length === 1 && slack.ephemerals[0].user === 'U_BROWSE_A' && slack.ephemerals[0].channel === 'C_BROWSE',
      slack.ephemerals.map((e) => e.user));
    check('nothing posted publicly (partner not notified)', slack.posts.length === 0, slack.posts.length);
    check('no message ts saved (auto-booker never touches it)', getMatch(matchId).calendar_suggestion_ts === null);

    const starts = buttonsOf(slack.ephemerals[0]?.blocks).map(valueStart);
    check(`offers many times (${starts.length})`, starts.length > 20, starts.length);
    check('first time is at least 30 minutes away', starts[0] - before >= 30 * MIN, starts[0]);
    check('every time starts on :00 or :30', starts.every((s) => s.getUTCMinutes() % 30 === 0 && s.getUTCSeconds() === 0));
    check('nothing at or after the round end', starts.every((s) => s.getTime() + 15 * MIN <= roundEnd.getTime()));
    check('weekdays 9–5 Eastern only', starts.every((s) =>
      s.getDay() >= 1 && s.getDay() <= 5 && s.getHours() >= 9 && (s.getHours() < 16 || (s.getHours() === 16 && s.getMinutes() <= 30))));
    check('at most two weeks shown', (slack.ephemerals[0]?.blocks ?? []).filter((b) => b.type === 'header').length <= 2);

    const long = slackClient();
    await suggestMeetingTimes(long, 'C_BROWSE', matchId, usersAB, settings, false,
      { browse: true, privateToUserId: 'U_BROWSE_A', roundEnd: new Date(Date.now() + 28 * DAY) });
    const headers = (long.ephemerals[0]?.blocks ?? []).filter((b) => b.type === 'header').length;
    check('4 weeks left in the round, all open → still exactly two weeks shown', headers === 2, headers);
    check('…and no "that\'s everything" line (later weeks were left out)',
      !textOf(long.ephemerals[0]?.blocks).includes("That's everything"));
  });

  await section('suggestMeetingTimes({ browse }) — busy times and PTO', async () => {
    // A is busy 10:00–12:00 ET on a weekday 2+ days out.
    let dayKey = addDaysToKey(localDateKey(new Date(), ET), 2);
    while ([0, 6].includes(new Date(`${dayKey}T12:00:00Z`).getUTCDay())) dayKey = addDaysToKey(dayKey, 1);
    graph = graphMock({ schedules: { [A]: [schedItem(at(dayKey, '10:00'), at(dayKey, '12:00'))] } });
    const slack = slackClient();
    await suggestMeetingTimes(slack, 'C_BROWSE', matchId, usersAB, settings, false,
      { browse: true, privateToUserId: 'U_BROWSE_A', roundEnd: new Date(Date.now() + 14 * DAY) });
    const starts = buttonsOf(slack.ephemerals[0]?.blocks).map((b) => b.value.split('|')[0]);
    const iso = (hhmm) => at(dayKey, hhmm).toISOString();
    check(`busy 10–12 on ${dayKey}: 10:00, 10:30, 11:00, 11:30 not offered`,
      ['10:00', '10:30', '11:00', '11:30'].every((t) => !starts.includes(iso(t))));
    check('…but 9:30 and 12:00 are', starts.includes(iso('09:30')) && starts.includes(iso('12:00')));

    // A on (Free-marked) PTO all of next week → that week is skipped and noted.
    const thisMonday = addDaysToKey(localDateKey(new Date(), ET), -((new Date().getDay() + 6) % 7));
    const nextMonday = addDaysToKey(thisMonday, 7);
    const weekAfter  = addDaysToKey(thisMonday, 14);
    graph = graphMock({ calendars: { [A]: [ownPto(nextMonday, addDaysToKey(nextMonday, 5))] } });
    const pto = slackClient();
    await suggestMeetingTimes(pto, 'C_BROWSE', matchId, usersAB, settings, false,
      { browse: true, privateToUserId: 'U_BROWSE_A', roundEnd: new Date(Date.now() + 21 * DAY) });
    const blocks = pto.ephemerals[0]?.blocks;
    const label = (key) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })
      .format(new Date(`${key}T12:00:00Z`));
    check(`PTO week noted: "No shared times the week of ${label(nextMonday)}."`,
      textOf(blocks).includes(`No shared times the week of ${label(nextMonday)}.`), textOf(blocks).slice(0, 400));
    check(`…and the list continues with the week of ${label(weekAfter)}`,
      (blocks ?? []).some((b) => b.type === 'header' && b.text.text.startsWith(`Week of ${label(weekAfter)}`)));
    check('no time offered during the PTO week',
      buttonsOf(blocks).map(valueStart).every((s) => localDateKey(s, ET) < nextMonday || localDateKey(s, ET) >= addDaysToKey(nextMonday, 5)));

    // A on PTO from the week after next until past the round end (like Dev in Nov 2026):
    // the list is short, so it closes by saying that's everything in the round.
    graph = graphMock({ calendars: { [A]: [ownPto(weekAfter, addDaysToKey(weekAfter, 60))] } });
    const short = slackClient();
    const roundEnd = zonedTime(addDaysToKey(thisMonday, 28), 9, 0, ET);
    await suggestMeetingTimes(short, 'C_BROWSE', matchId, usersAB, settings, false,
      { browse: true, privateToUserId: 'U_BROWSE_A', roundEnd });
    const shortBlocks = short.ephemerals[0]?.blocks ?? [];
    const endLabel = new Intl.DateTimeFormat('en-US', { timeZone: ET, weekday: 'short', month: 'short', day: 'numeric' }).format(roundEnd);
    check(`PTO for the rest of the round → closes with "That's everything before this round wraps up on ${endLabel}."`,
      shortBlocks[shortBlocks.length - 1]?.elements?.[0]?.text === `_That's everything before this round wraps up on ${endLabel}._`,
      shortBlocks[shortBlocks.length - 1]);
  });

  await section('suggestMeetingTimes({ browse }) — nothing open / no round end', async () => {
    // A on PTO for the whole range.
    const today = localDateKey(new Date(), ET);
    graph = graphMock({ calendars: { [A]: [ownPto(addDaysToKey(today, -1), addDaysToKey(today, 40))] } });
    const roundEnd = zonedTime(addDaysToKey(today, 9), 9, 0, ET);
    const none = slackClient();
    await suggestMeetingTimes(none, 'C_BROWSE', matchId, usersAB, settings, false,
      { browse: true, privateToUserId: 'U_BROWSE_A', roundEnd });
    const endLabel = new Intl.DateTimeFormat('en-US', { timeZone: ET, weekday: 'short', month: 'short', day: 'numeric' }).format(roundEnd);
    const notice = none.ephemerals[0]?.blocks?.[0]?.text?.text ?? '';
    check('no open time → private notice, no buttons',
      none.ephemerals.length === 1 && none.posts.length === 0 && buttonsOf(none.ephemerals[0].blocks).length === 0);
    check(`notice names the round end ("before this round wraps up on ${endLabel}")`,
      notice.includes(`before this round wraps up on ${endLabel}`), notice);
    check('notice reassures nothing changed', notice.includes("hasn't been notified"));

    const noEnd = slackClient();
    await suggestMeetingTimes(noEnd, 'C_BROWSE', matchId, usersAB, settings, false,
      { browse: true, privateToUserId: 'U_BROWSE_A' });
    check('no round end known → notice says "in the next two weeks"',
      (noEnd.ephemerals[0]?.blocks?.[0]?.text?.text ?? '').includes('in the next two weeks'));

    graph = graphMock();
    const past = slackClient();
    await suggestMeetingTimes(past, 'C_BROWSE', matchId, usersAB, settings, false,
      { browse: true, privateToUserId: 'U_BROWSE_A', roundEnd: new Date(Date.now() - DAY) });
    const starts = buttonsOf(past.ephemerals[0]?.blocks).map(valueStart);
    check('round already over → falls back to the next two weeks (still offers times)',
      starts.length > 0 && starts.every((s) => s - Date.now() <= 15 * DAY), starts.length);

    const nobody = slackClient();
    await suggestMeetingTimes(nobody, 'C_BROWSE', matchId, usersAB, settings, false, { browse: true });
    check('browse without a person to show it to → posts nothing at all',
      nobody.ephemerals.length === 0 && nobody.posts.length === 0);
  });

  // ── Reschedule wiring ──────────────────────────────────────────────────────
  await section('postPrivateTimeOptions() / performReschedule() — wiring', async () => {
    graph = graphMock();
    const a = createUser('U_BROWSE_A', 'Browse A');
    const b = createUser('U_BROWSE_B', 'Browse B');
    saveUserEmail('U_BROWSE_A', A);
    saveUserEmail('U_BROWSE_B', B);
    saveMatchMembers(matchId, [a.id, b.id]);
    saveBooking(matchId, { calendarEventId: 'evt-browse', teamsLink: null });

    suggestCalls.length = 0;
    const slack = slackClient();
    await postPrivateTimeOptions(slack, getMatch(matchId), 'U_BROWSE_B');
    const opts = suggestCalls[0]?.[6] ?? {};
    const expectedEnd = getRoundEndDate(getRoundById(roundId), { ...getSettings(), calendar_enabled: true });
    check('asks for the private full list for the requester',
      opts.browse === true && opts.privateToUserId === 'U_BROWSE_B', opts);
    check('passes the round end from the match\'s round', opts.roundEnd?.getTime() === expectedEnd?.getTime(),
      { got: opts.roundEnd, expected: expectedEnd });
    check('list delivered privately', slack.ephemerals.length === 1 && slack.posts.length === 0);
    check('the booking is NOT touched (safe for "More times")', getMatch(matchId).calendar_event_id === 'evt-browse');

    const resched = slackClient();
    await performReschedule(resched, getMatch(matchId), 'U_BROWSE_A');
    check('Reschedule: resets the booking, keeps the old event for deletion',
      getMatch(matchId).calendar_event_id === null && getMatch(matchId).previous_event_id === 'evt-browse');
    check('Reschedule: posts the private full list', resched.ephemerals.length === 1 && buttonsOf(resched.ephemerals[0].blocks).length > 3);
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
