'use strict';

// PTO detection tests
//
// DocMe360 PTO goes out as an invite that includes pto@docme360.com, usually
// marked "Free" — so Outlook free/busy (getSchedule) never sees it, and the bot
// offered times in the middle of people's vacations (Nov 2026).
//
// Fix: calendarReader also reads each person's events (calendarView) and
// blocks any event that person ORGANIZED that invites the PTO address,
// however it's marked. Someone else's PTO on your calendar is not added.
//
// No Azure credentials needed — Microsoft Graph is simulated.
//
// Run: npm run test:pto

const { initDb } = require('../src/db/init');
initDb();

const config  = require('../src/config');
const msGraph = require('../src/integrations/msGraph');

// calendarScheduler destructures getGraphClient at require time, so the
// wiring test's stub must be in place before it's required. The real
// calendarReader and slotFinder are used throughout.
let schedulerGraph = null;
const realGetGraphClient = msGraph.getGraphClient;
msGraph.getGraphClient = () => schedulerGraph;
const { suggestMeetingTimes } = require('../src/integrations/calendarScheduler');
msGraph.getGraphClient = realGetGraphClient;

const calendarReader = require('../src/integrations/calendarReader');
const { getFreeBusy, parseResponse, getOwnPtoBlocks, isOwnPtoEvent } = calendarReader;
const { findSlots } = require('../src/lib/slotFinder');

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

/** Runs one block of checks; a crash counts as a failure instead of stopping the run. */
async function section(title, fn) {
  console.log(`\n${title}`);
  try {
    await fn();
  } catch (err) {
    console.error(`  ❌ section crashed: ${err.message}`);
    failed++;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DEV   = 'dev@example.test';
const SAM   = 'Sam.Partner@example.test';
const OTHER = 'someone.else@example.test';
const PTO   = 'pto@docme360.com';

/**
 * A calendarView event as Graph returns it with Prefer: outlook.timezone="UTC".
 * All-day events come back as midnight-to-midnight UTC (verified on prod).
 */
function event({
  organizer, isOrganizer, start, end, allDay = true, showAs = 'free',
  attendees = [PTO], cancelled = false,
}) {
  const dt = (v) => (allDay ? `${v}T00:00:00.0000000` : v.replace(/Z$/, '.0000000'));
  return {
    organizer:   { emailAddress: { name: 'x', address: organizer } },
    isOrganizer,
    isAllDay:    allDay,
    isCancelled: cancelled,
    showAs,
    start: { dateTime: dt(start), timeZone: 'UTC' },
    end:   { dateTime: dt(end),   timeZone: 'UTC' },
    attendees: attendees.map((address) => ({ type: 'required', emailAddress: { name: 'x', address } })),
  };
}

/** Dev's own PTO: Mon Nov 23 → Fri Dec 4 2026, all-day, marked Free. */
const devPto = (over = {}) =>
  event({ organizer: DEV, isOrganizer: true, start: '2026-11-23', end: '2026-12-05', ...over });

/**
 * Simulated Graph client.
 *   schedules:  { email: scheduleItems[] } → getSchedule (POST)
 *   calendars:  { email: event[] | { pages: event[][] } } → calendarView (GET),
 *               paged with @odata.nextLink when `pages` is given
 *   failGet:    true → every calendarView call throws
 *   failPost:   true → getSchedule throws
 *   endlessNextLink: true → every page links to another page
 * Records every call in `calls`.
 */
function graphMock({ schedules = {}, calendars = {}, failGet = false, failPost = false, endlessNextLink = false } = {}) {
  const calls = [];
  const client = {
    calls,
    api(url) {
      const call = { url, headers: {} };
      const req = {
        header(name, value) { call.headers[name] = value; return req; },
        async post(body) {
          calls.push({ kind: 'getSchedule', ...call, body });
          if (failPost) throw new Error('getSchedule unavailable');
          return {
            value: body.schedules.map((email) => ({ scheduleId: email, scheduleItems: schedules[email] ?? [] })),
          };
        },
        async get() {
          calls.push({ kind: 'calendarView', ...call });
          if (failGet) throw new Error('calendarView unavailable');
          const email = decodeURIComponent(url.match(/\/users\/([^/]+)\/calendarView/)[1]);
          const page  = Number((url.match(/[?&]page=(\d+)/) ?? [])[1] ?? 1);
          const next  = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/calendarView?page=${page + 1}`;
          const cal   = calendars[email] ?? [];
          if (endlessNextLink) return { value: [], '@odata.nextLink': next };
          if (Array.isArray(cal)) return { value: cal };
          const value = cal.pages[page - 1] ?? [];
          return page < cal.pages.length ? { value, '@odata.nextLink': next } : { value };
        },
      };
      return req;
    },
  };
  return client;
}

/** getSchedule item (Graph format: UTC, no Z). */
function schedItem(start, end, status) {
  return { status, start: { dateTime: start, timeZone: 'UTC' }, end: { dateTime: end, timeZone: 'UTC' } };
}

const WINDOW = { start: new Date('2026-11-16T14:00:00Z'), end: new Date('2026-12-12T00:00:00Z') };

const localDay = (date, tz) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const localTime = (date, tz) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(date);

console.log('\n=== PTO Detection Tests ===');

(async () => {
  // ── Which events count as PTO ──────────────────────────────────────────────
  await section('isOwnPtoEvent() — which events count', () => {
    check('own PTO marked Free → counts', isOwnPtoEvent(devPto(), DEV));
    check('own PTO marked Out of Office → counts', isOwnPtoEvent(devPto({ showAs: 'oof' }), DEV));
    check('own PTO marked Busy → counts', isOwnPtoEvent(devPto({ showAs: 'busy' }), DEV));
    check("someone else's PTO on your calendar → does NOT count",
      !isOwnPtoEvent(event({ organizer: OTHER, isOrganizer: false, start: '2026-11-23', end: '2026-12-05' }), DEV));
    check("someone else's PTO marked Out of Office on your calendar → does NOT count",
      !isOwnPtoEvent(event({ organizer: OTHER, isOrganizer: false, showAs: 'oof', start: '2026-11-23', end: '2026-12-05' }), DEV));
    check('own all-day event without pto@ (e.g. a conference) → does NOT count',
      !isOwnPtoEvent(devPto({ attendees: ['team@example.test'] }), DEV));
    check('own event with no attendees at all → does NOT count', !isOwnPtoEvent(devPto({ attendees: [] }), DEV));
    check('cancelled own PTO → does NOT count', !isOwnPtoEvent(devPto({ cancelled: true }), DEV));
    check('pto@ among other attendees → counts',
      isOwnPtoEvent(devPto({ attendees: ['manager@example.test', PTO, 'team@example.test'] }), DEV));
    check('address case is ignored (PTO@DocMe360.com, DEV@…)',
      isOwnPtoEvent(devPto({ attendees: ['PTO@DocMe360.com'] }), DEV.toUpperCase()));
    check('ownership falls back to organizer address when isOrganizer is missing',
      isOwnPtoEvent(devPto({ isOrganizer: undefined, organizer: 'DEV@EXAMPLE.TEST' }), DEV));
    check('missing isOrganizer + different organizer → does NOT count',
      !isOwnPtoEvent(devPto({ isOrganizer: undefined, organizer: OTHER }), DEV));
    check('garbage input → false, never throws',
      !isOwnPtoEvent(null, DEV) && !isOwnPtoEvent({}, DEV) && !isOwnPtoEvent({ isOrganizer: true }, DEV));

    const saved = config.ptoAttendeeAddress;
    config.ptoAttendeeAddress = 'timeoff@example.test';
    const overridden = isOwnPtoEvent(devPto({ attendees: ['timeoff@example.test'] }), DEV) &&
                       !isOwnPtoEvent(devPto(), DEV);
    config.ptoAttendeeAddress = saved;
    check('PTO address comes from config (PTO_ATTENDEE_ADDRESS override)', overridden);
    check('default PTO address is pto@docme360.com', config.ptoAttendeeAddress === PTO, config.ptoAttendeeAddress);
  });

  // ── Turning PTO events into busy blocks ────────────────────────────────────
  await section('getOwnPtoBlocks() — times', async () => {
    const g = graphMock({ calendars: { [DEV]: [devPto()] } });
    const blocks = await getOwnPtoBlocks(g, DEV, WINDOW.start, WINDOW.end);
    check('one block for one PTO event', blocks.length === 1, blocks.length);
    check("status is 'pto'", blocks[0]?.status === 'pto', blocks[0]?.status);
    check('all-day start → midnight Eastern (05:00 UTC in November)',
      blocks[0]?.start.toISOString() === '2026-11-23T05:00:00.000Z', blocks[0]?.start);
    check('all-day end → midnight Eastern after the last day (Sat Dec 5)',
      blocks[0]?.end.toISOString() === '2026-12-05T05:00:00.000Z', blocks[0]?.end);

    const summer = await getOwnPtoBlocks(
      graphMock({ calendars: { [DEV]: [devPto({ start: '2026-07-06', end: '2026-07-07' })] } }),
      DEV, new Date('2026-07-01T00:00:00Z'), new Date('2026-07-31T00:00:00Z'));
    check('summer all-day → 04:00 UTC (daylight time)',
      summer[0]?.start.toISOString() === '2026-07-06T04:00:00.000Z' &&
      summer[0]?.end.toISOString()   === '2026-07-07T04:00:00.000Z', summer[0]);

    const dst = await getOwnPtoBlocks(
      graphMock({ calendars: { [DEV]: [devPto({ start: '2026-10-30', end: '2026-11-03' })] } }),
      DEV, new Date('2026-10-26T00:00:00Z'), new Date('2026-11-06T00:00:00Z'));
    check('PTO across the Nov 1 clock change: starts 04:00 UTC, ends 05:00 UTC',
      dst[0]?.start.toISOString() === '2026-10-30T04:00:00.000Z' &&
      dst[0]?.end.toISOString()   === '2026-11-03T05:00:00.000Z', dst[0]);

    const halfDay = await getOwnPtoBlocks(
      graphMock({ calendars: { [DEV]: [devPto({ allDay: false, start: '2026-11-18T18:00:00Z', end: '2026-11-18T22:00:00Z' })] } }),
      DEV, WINDOW.start, WINDOW.end);
    check('timed (half-day) PTO keeps its exact times',
      halfDay[0]?.start.toISOString() === '2026-11-18T18:00:00.000Z' &&
      halfDay[0]?.end.toISOString()   === '2026-11-18T22:00:00.000Z', halfDay[0]);

    const savedTz = config.calendarTimezone;
    config.calendarTimezone = 'America/Chicago';
    const central = await getOwnPtoBlocks(g, DEV, WINDOW.start, WINDOW.end);
    config.calendarTimezone = savedTz;
    check('all-day anchoring follows CALENDAR_TIMEZONE (Central → 06:00 UTC)',
      central[0]?.start.toISOString() === '2026-11-23T06:00:00.000Z', central[0]?.start);

    const mixed = await getOwnPtoBlocks(graphMock({ calendars: { [DEV]: [
      devPto({ start: '2026-11-23', end: '2026-11-24' }),
      event({ organizer: OTHER, isOrganizer: false, start: '2026-11-25', end: '2026-11-26' }),
      devPto({ start: '2026-11-27', end: '2026-11-28', attendees: ['team@example.test'] }),
      { ...devPto(), start: undefined },                       // unreadable — skipped
      devPto({ start: '2026-11-30', end: '2026-11-30' }),      // zero-length — skipped
      devPto({ start: '2026-12-01', end: '2026-12-02' }),
    ] } }), DEV, WINDOW.start, WINDOW.end);
    check('only own PTO kept; bad events skipped without losing the rest',
      mixed.length === 2 &&
      mixed[0].start.toISOString() === '2026-11-23T05:00:00.000Z' &&
      mixed[1].start.toISOString() === '2026-12-01T05:00:00.000Z',
      mixed.map((b) => b.start.toISOString()));
  });

  await section('getOwnPtoBlocks() — the request it sends', async () => {
    const g = graphMock({ calendars: { [DEV]: [] } });
    await getOwnPtoBlocks(g, DEV, WINDOW.start, WINDOW.end);
    const call   = g.calls[0];
    const select = decodeURIComponent((call?.url.match(/\$select=([^&]+)/) ?? [])[1] ?? '').split(',');
    check('reads calendarView for that person', call?.url.startsWith(`/users/${encodeURIComponent(DEV)}/calendarView?`), call?.url);
    check('PRIVACY: never asks for the event title (subject)', !select.includes('subject'), select);
    check('PRIVACY: never asks for the event body', !select.includes('body') && !select.includes('bodyPreview'), select);
    check('asks only for the fields it needs',
      ['organizer', 'attendees', 'start', 'end', 'isAllDay', 'isCancelled', 'isOrganizer'].every((f) => select.includes(f)) &&
      select.length === 7, select);
    check('window matches the free/busy window',
      call?.url.includes(`startDateTime=${encodeURIComponent(WINDOW.start.toISOString())}`) &&
      call?.url.includes(`endDateTime=${encodeURIComponent(WINDOW.end.toISOString())}`), call?.url);
    check('asks for 100 events per page', call?.url.includes('$top=100'), call?.url);
    check('asks Graph for UTC times', call?.headers.Prefer === 'outlook.timezone="UTC"', call?.headers);
  });

  await section('getOwnPtoBlocks() — paging and failures', async () => {
    const paged = graphMock({ calendars: { [DEV]: { pages: [
      [devPto({ start: '2026-11-23', end: '2026-11-24' })],
      [],
      [devPto({ start: '2026-12-01', end: '2026-12-02' })],
    ] } } });
    const blocks = await getOwnPtoBlocks(paged, DEV, WINDOW.start, WINDOW.end);
    check('follows @odata.nextLink to later pages', blocks.length === 2 && paged.calls.length === 3,
      { blocks: blocks.length, calls: paged.calls.length });
    check('uses the nextLink URL as given', paged.calls[1]?.url.includes('page=2'), paged.calls[1]?.url);
    check('UTC header sent on every page', paged.calls.every((c) => c.headers.Prefer === 'outlook.timezone="UTC"'));

    const endless = graphMock({ endlessNextLink: true });
    const capped  = await getOwnPtoBlocks(endless, DEV, WINDOW.start, WINDOW.end);
    check('stops after 10 pages (never loops forever)', endless.calls.length === 10 && capped.length === 0,
      endless.calls.length);

    let threw = false;
    let failedBlocks;
    try { failedBlocks = await getOwnPtoBlocks(graphMock({ failGet: true }), DEV, WINDOW.start, WINDOW.end); }
    catch { threw = true; }
    check('Graph error → no throw, no blocks', !threw && failedBlocks.length === 0);

    // Page 1 fine, page 2 fails → keep what page 1 found.
    const flaky = graphMock({ calendars: { [DEV]: { pages: [[devPto()], [devPto()]] } } });
    const realApi = flaky.api.bind(flaky);
    flaky.api = (url) => {
      const req = realApi(url);
      if (url.includes('page=2')) req.get = async () => { throw new Error('timeout'); };
      return req;
    };
    const partial = await getOwnPtoBlocks(flaky, DEV, WINDOW.start, WINDOW.end);
    check('failure on a later page keeps blocks already found', partial.length === 1, partial.length);

    check('no client or no email → [] without a call',
      (await getOwnPtoBlocks(null, DEV, WINDOW.start, WINDOW.end)).length === 0 &&
      (await getOwnPtoBlocks(graphMock(), '', WINDOW.start, WINDOW.end)).length === 0);
  });

  // ── getFreeBusy: what every suggestion path receives ───────────────────────
  await section('getFreeBusy() — PTO merged into free/busy', async () => {
    // Dev organized the PTO (Free). Sam was invited, so it's on Sam's calendar too.
    const samCopy = event({ organizer: DEV, isOrganizer: false, start: '2026-11-23', end: '2026-12-05' });
    const g = graphMock({
      schedules: { [DEV]: [schedItem('2026-11-17T15:00:00', '2026-11-17T16:00:00', 'busy')] },
      calendars: { [DEV]: [devPto()], [SAM]: [samCopy] },
    });

    const logs = [];
    const realLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    let result;
    try { result = await getFreeBusy(g, [DEV, SAM], WINDOW.start, WINDOW.end); }
    finally { console.log = realLog; }

    const dev = result.find((p) => p.email === DEV);
    const sam = result.find((p) => p.email === SAM);
    check('Dev keeps the meeting getSchedule reported', dev?.busySlots.some((b) => b.status === 'busy'));
    check('Dev gets the PTO block (Free PTO no longer invisible)',
      dev?.busySlots.some((b) => b.status === 'pto' && b.start.toISOString() === '2026-11-23T05:00:00.000Z'));
    check("Sam is NOT blocked by Dev's PTO", sam?.busySlots.length === 0, sam?.busySlots);
    check('one getSchedule call + one calendarView call per person',
      g.calls.filter((c) => c.kind === 'getSchedule').length === 1 &&
      g.calls.filter((c) => c.kind === 'calendarView').length === 2,
      g.calls.map((c) => c.kind));
    check('logs that PTO was applied', logs.some((l) => l.includes('PTO period')), logs);
    check('PRIVACY: logs never include an email address', logs.every((l) => !l.includes('@')), logs);

    const down = graphMock({
      schedules: { [DEV]: [schedItem('2026-11-17T15:00:00', '2026-11-17T16:00:00', 'busy')] },
      failGet: true,
    });
    const degraded = await getFreeBusy(down, [DEV, SAM], WINDOW.start, WINDOW.end);
    const plain = parseResponse({ value: [
      { scheduleId: DEV, scheduleItems: [schedItem('2026-11-17T15:00:00', '2026-11-17T16:00:00', 'busy')] },
      { scheduleId: SAM, scheduleItems: [] },
    ] });
    check('calendarView down → exactly the plain free/busy result',
      JSON.stringify(degraded) === JSON.stringify(plain), degraded);

    const allDown = graphMock({ failPost: true, calendars: { [DEV]: [devPto()] } });
    const empty = await getFreeBusy(allDown, [DEV, SAM], WINDOW.start, WINDOW.end);
    check('getSchedule down → unchanged behaviour (empty schedules)',
      empty.length === 2 && empty.every((p) => p.busySlots.length === 0), empty);
    check('getSchedule down → no extra calendarView calls',
      allDown.calls.every((c) => c.kind === 'getSchedule'), allDown.calls.map((c) => c.kind));
  });

  // ── End to end: the slots people would actually be offered ─────────────────
  await section('slots — Dev & Sam (Dev on Free PTO Nov 23 → Dec 4)', async () => {
    const samCopy = event({ organizer: DEV, isOrganizer: false, start: '2026-11-23', end: '2026-12-05' });
    const g = graphMock({ calendars: { [DEV]: [devPto()], [SAM]: [samCopy] } });
    const busy = await getFreeBusy(g, [DEV, SAM], WINDOW.start, WINDOW.end);

    for (const tz of ['America/New_York', 'America/Chicago', 'America/Los_Angeles']) {
      const slots = findSlots(busy, WINDOW.start, WINDOW.end, 15,
        { maxSlots: 10000, slotIntervalMinutes: 30, timezoneId: tz });
      const days = new Set(slots.map((s) => localDay(s.start, tz)));
      const short = tz.split('/')[1].replace('_', ' ');
      const duringPto = slots.filter((s) => localDay(s.start, tz) >= '2026-11-23' && localDay(s.start, tz) <= '2026-12-04');
      check(`${short}: no slots on any PTO day`, duringPto.length === 0,
        duringPto.slice(0, 3).map((s) => s.start.toISOString()));
      check(`${short}: Fri Nov 20 (day before) still fully open, incl. 4:30 PM`,
        slots.some((s) => localDay(s.start, tz) === '2026-11-20' && localTime(s.start, tz) === '4:30 PM'));
      check(`${short}: Mon Dec 7 (back from PTO) open from 9:00 AM`,
        days.has('2026-12-07') && slots.some((s) => localDay(s.start, tz) === '2026-12-07' && localTime(s.start, tz) === '9:00 AM'));
    }

    // Without PTO detection (plain getSchedule), the PTO days were wide open:
    const before = findSlots(parseResponse({ value: [{ scheduleId: DEV, scheduleItems: [] }, { scheduleId: SAM, scheduleItems: [] }] }),
      WINDOW.start, WINDOW.end, 15, { maxSlots: 10000, slotIntervalMinutes: 30, timezoneId: 'America/New_York' });
    const beforeDuring = before.filter((s) => localDay(s.start, 'America/New_York') >= '2026-11-23' &&
                                              localDay(s.start, 'America/New_York') <= '2026-12-04');
    check(`(before this fix the same calendars offered ${beforeDuring.length} slots during the PTO)`, beforeDuring.length > 0);

    const samAlone = findSlots(busy.filter((p) => p.email === SAM), WINDOW.start, WINDOW.end, 15,
      { maxSlots: 10000, slotIntervalMinutes: 30, timezoneId: 'America/New_York' });
    check("Sam on his own is still free during Dev's PTO",
      samAlone.some((s) => localDay(s.start, 'America/New_York') === '2026-11-24'));
  });

  await section('suggestMeetingTimes() — wiring (starter suggestions see PTO)', async () => {
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    // Timed PTO covering the whole suggestion range (today → +30 days).
    const longPto = (organizer, isOrganizer) => event({
      organizer, isOrganizer, allDay: false,
      start: iso(now - 24 * 3600e3), end: iso(now + 30 * 24 * 3600e3),
    });
    const users = [
      { slack_user_id: 'U_PTO_DEV', display_name: 'Dev', slack_email: DEV, ms_timezone: 'America/New_York' },
      { slack_user_id: 'U_PTO_SAM', display_name: 'Sam', slack_email: SAM, ms_timezone: 'America/New_York' },
    ];
    const settings = { calendar_enabled: 1, meeting_duration: 15, calendar_timezone: 'America/New_York' };
    const slack = () => {
      const posts = [];
      return { posts, chat: {
        postMessage:   async (m) => { posts.push(m); return { ts: '1.1' }; },
        postEphemeral: async (m) => { posts.push(m); return {}; },
      } };
    };

    schedulerGraph = graphMock({ calendars: { [DEV]: [longPto(DEV, true)] } });
    const onPto = slack();
    await suggestMeetingTimes(onPto, 'C_PTO_TEST', -1, users, settings);
    check('Dev on PTO for the whole range → "couldn\'t find a time" notice, no buttons',
      onPto.posts.length === 1 && onPto.posts[0].text.includes("couldn't find") &&
      onPto.posts[0].blocks.every((b) => b.type !== 'actions'), onPto.posts.map((p) => p.text));

    schedulerGraph = graphMock({ calendars: { [SAM]: [longPto(OTHER, false)], [DEV]: [longPto(OTHER, false)] } });
    const othersPto = slack();
    await suggestMeetingTimes(othersPto, 'C_PTO_TEST', -1, users, settings);
    const buttons = othersPto.posts[0]?.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements) ?? [];
    check("only someone else's PTO on their calendars → normal 3 suggestions", buttons.length === 3, buttons.length);
    schedulerGraph = null;
  });

  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
