'use strict';

// PTO handling tests
//
// DocMe360 PTO goes out as an invite that includes pto@docme360.com, usually
// marked "Free". Outlook free/busy (getSchedule) gets it wrong both ways:
//
//   1. Your own Free-marked PTO is invisible — the bot offered times in the
//      middle of people's vacations (Nov 2026).
//      Fix: any event a person ORGANIZED that invites the PTO address blocks
//      them, however it's marked.
//
//   2. A teammate's PTO showing as busy/out-of-office on YOUR calendar blocked
//      you — one person's PTO blocked 3 coworkers for 19 days (Nov 2026).
//      Fix: that free/busy block is removed.
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

const { getFreeBusy, parseResponse, readPtoEvents, isOwnPtoEvent, dropTeammatePto } =
  require('../src/integrations/calendarReader');
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

/** Runs fn with console.log captured; returns { result, logs }. */
async function capturingLogs(fn) {
  const logs = [];
  const realLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  try { return { result: await fn(), logs }; }
  finally { console.log = realLog; }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DEV   = 'dev@example.test';
const SAM   = 'Sam.Partner@example.test';
const ALEX  = 'alex@example.test';
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

/** The same PTO as it sits on an invitee's calendar (default: shown as Out of Office). */
const devPtoOnInvitee = (over = {}) =>
  event({ organizer: DEV, isOrganizer: false, start: '2026-11-23', end: '2026-12-05', showAs: 'oof', ...over });

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
          if (endlessNextLink) return { value: page === 1 && Array.isArray(cal) ? cal : [], '@odata.nextLink': next };
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

/** How getSchedule reports Dev's all-day PTO on an Eastern mailbox (verified on prod: 05:00 UTC). */
const DEV_PTO_FREEBUSY_ET = schedItem('2026-11-23T05:00:00.0000000', '2026-12-05T05:00:00.0000000', 'oof');
const SAM_MEETING         = schedItem('2026-11-24T15:00:00.0000000', '2026-11-24T16:00:00.0000000', 'busy');

const WINDOW = { start: new Date('2026-11-16T14:00:00Z'), end: new Date('2026-12-12T00:00:00Z') };
const ET = 'America/New_York';

const localDay = (date, tz) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const localTime = (date, tz) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
const allSlots = (busy, tz = ET) =>
  findSlots(busy, WINDOW.start, WINDOW.end, 15, { maxSlots: 10000, slotIntervalMinutes: 30, timezoneId: tz });
const onPtoDays = (slots, tz = ET) =>
  slots.filter((s) => localDay(s.start, tz) >= '2026-11-23' && localDay(s.start, tz) <= '2026-12-04');

console.log('\n=== PTO Handling Tests ===');

(async () => {
  // ── Which events count as your own PTO ─────────────────────────────────────
  await section('isOwnPtoEvent() — which events count as your PTO', () => {
    check('own PTO marked Free → counts', isOwnPtoEvent(devPto(), DEV));
    check('own PTO marked Out of Office → counts', isOwnPtoEvent(devPto({ showAs: 'oof' }), DEV));
    check('own PTO marked Busy → counts', isOwnPtoEvent(devPto({ showAs: 'busy' }), DEV));
    check("someone else's PTO on your calendar → does NOT count", !isOwnPtoEvent(devPtoOnInvitee(), SAM));
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

  // ── Own PTO → busy blocks ──────────────────────────────────────────────────
  await section('readPtoEvents() — your own PTO becomes a busy block', async () => {
    const g = graphMock({ calendars: { [DEV]: [devPto()] } });
    const { own } = await readPtoEvents(g, DEV, WINDOW.start, WINDOW.end);
    check('one block for one PTO event', own.length === 1, own.length);
    check("status is 'pto'", own[0]?.status === 'pto', own[0]?.status);
    check('all-day start → midnight Eastern (05:00 UTC in November)',
      own[0]?.start.toISOString() === '2026-11-23T05:00:00.000Z', own[0]?.start);
    check('all-day end → midnight Eastern after the last day (Sat Dec 5)',
      own[0]?.end.toISOString() === '2026-12-05T05:00:00.000Z', own[0]?.end);

    const summer = (await readPtoEvents(
      graphMock({ calendars: { [DEV]: [devPto({ start: '2026-07-06', end: '2026-07-07' })] } }),
      DEV, new Date('2026-07-01T00:00:00Z'), new Date('2026-07-31T00:00:00Z'))).own;
    check('summer all-day → 04:00 UTC (daylight time)',
      summer[0]?.start.toISOString() === '2026-07-06T04:00:00.000Z' &&
      summer[0]?.end.toISOString()   === '2026-07-07T04:00:00.000Z', summer[0]);

    const dst = (await readPtoEvents(
      graphMock({ calendars: { [DEV]: [devPto({ start: '2026-10-30', end: '2026-11-03' })] } }),
      DEV, new Date('2026-10-26T00:00:00Z'), new Date('2026-11-06T00:00:00Z'))).own;
    check('PTO across the Nov 1 clock change: starts 04:00 UTC, ends 05:00 UTC',
      dst[0]?.start.toISOString() === '2026-10-30T04:00:00.000Z' &&
      dst[0]?.end.toISOString()   === '2026-11-03T05:00:00.000Z', dst[0]);

    const halfDay = (await readPtoEvents(
      graphMock({ calendars: { [DEV]: [devPto({ allDay: false, start: '2026-11-18T18:00:00Z', end: '2026-11-18T22:00:00Z' })] } }),
      DEV, WINDOW.start, WINDOW.end)).own;
    check('timed (half-day) PTO keeps its exact times',
      halfDay[0]?.start.toISOString() === '2026-11-18T18:00:00.000Z' &&
      halfDay[0]?.end.toISOString()   === '2026-11-18T22:00:00.000Z', halfDay[0]);

    const savedTz = config.calendarTimezone;
    config.calendarTimezone = 'America/Chicago';
    const central = (await readPtoEvents(g, DEV, WINDOW.start, WINDOW.end)).own;
    config.calendarTimezone = savedTz;
    check('all-day anchoring follows CALENDAR_TIMEZONE (Central → 06:00 UTC)',
      central[0]?.start.toISOString() === '2026-11-23T06:00:00.000Z', central[0]?.start);

    const mixed = (await readPtoEvents(graphMock({ calendars: { [DEV]: [
      devPto({ start: '2026-11-23', end: '2026-11-24' }),
      event({ organizer: OTHER, isOrganizer: false, start: '2026-11-25', end: '2026-11-26' }),
      devPto({ start: '2026-11-27', end: '2026-11-28', attendees: ['team@example.test'] }),
      { ...devPto(), start: undefined },                       // unreadable — skipped
      devPto({ start: '2026-11-30', end: '2026-11-30' }),      // zero-length — skipped
      devPto({ start: '2026-12-01', end: '2026-12-02' }),
    ] } }), DEV, WINDOW.start, WINDOW.end)).own;
    check('only own PTO kept; bad events skipped without losing the rest',
      mixed.length === 2 &&
      mixed[0].start.toISOString() === '2026-11-23T05:00:00.000Z' &&
      mixed[1].start.toISOString() === '2026-12-01T05:00:00.000Z',
      mixed.map((b) => b.start.toISOString()));
  });

  await section('readPtoEvents() — sorting teammate PTO and other events', async () => {
    const r = await readPtoEvents(graphMock({ calendars: { [SAM]: [
      devPtoOnInvitee(),                                                   // teammate PTO, OOF
      devPtoOnInvitee({ showAs: 'free', start: '2026-12-07', end: '2026-12-08' }), // teammate PTO, Free
      event({ organizer: OTHER, isOrganizer: false, showAs: 'busy', allDay: false, attendees: [SAM],
        start: '2026-11-24T15:00:00Z', end: '2026-11-24T16:00:00Z' }),   // ordinary meeting
      devPtoOnInvitee({ cancelled: true, start: '2026-12-09', end: '2026-12-10' }), // cancelled
    ] } }), SAM, WINDOW.start, WINDOW.end);
    check('teammate PTO showing as OOF → listed for removal', r.teammatePto.length === 1, r.teammatePto);
    check('its span is kept as Graph sent it (all-day at 00:00 UTC)',
      r.teammatePto[0]?.start.toISOString() === '2026-11-23T00:00:00.000Z' && r.teammatePto[0]?.isAllDay === true,
      r.teammatePto[0]);
    check('teammate PTO showing as Free → ignored (it never blocked anyone)',
      r.teammatePto.every((s) => s.start.toISOString() !== '2026-12-07T00:00:00.000Z'));
    check('ordinary busy meeting → kept as a look-alike guard', r.otherBusy.length === 1, r.otherBusy);
    check('cancelled events ignored', r.teammatePto.length + r.otherBusy.length === 2);
    check('not your own PTO, so nothing added', r.own.length === 0);
  });

  await section('readPtoEvents() — the request it sends', async () => {
    const g = graphMock({ calendars: { [DEV]: [] } });
    await readPtoEvents(g, DEV, WINDOW.start, WINDOW.end);
    const call   = g.calls[0];
    const select = decodeURIComponent((call?.url.match(/\$select=([^&]+)/) ?? [])[1] ?? '').split(',');
    check('reads calendarView for that person', call?.url.startsWith(`/users/${encodeURIComponent(DEV)}/calendarView?`), call?.url);
    check('PRIVACY: never asks for the event title (subject)', !select.includes('subject'), select);
    check('PRIVACY: never asks for the event body', !select.includes('body') && !select.includes('bodyPreview'), select);
    check('asks only for the fields it needs',
      ['organizer', 'attendees', 'start', 'end', 'isAllDay', 'isCancelled', 'isOrganizer', 'showAs']
        .every((f) => select.includes(f)) && select.length === 8, select);
    check('window matches the free/busy window',
      call?.url.includes(`startDateTime=${encodeURIComponent(WINDOW.start.toISOString())}`) &&
      call?.url.includes(`endDateTime=${encodeURIComponent(WINDOW.end.toISOString())}`), call?.url);
    check('asks for 100 events per page', call?.url.includes('$top=100'), call?.url);
    check('asks Graph for UTC times', call?.headers.Prefer === 'outlook.timezone="UTC"', call?.headers);
  });

  await section('readPtoEvents() — paging and failures', async () => {
    const paged = graphMock({ calendars: { [DEV]: { pages: [
      [devPto({ start: '2026-11-23', end: '2026-11-24' })],
      [],
      [devPto({ start: '2026-12-01', end: '2026-12-02' })],
    ] } } });
    const { own } = await readPtoEvents(paged, DEV, WINDOW.start, WINDOW.end);
    check('follows @odata.nextLink to later pages', own.length === 2 && paged.calls.length === 3,
      { blocks: own.length, calls: paged.calls.length });
    check('uses the nextLink URL as given', paged.calls[1]?.url.includes('page=2'), paged.calls[1]?.url);
    check('UTC header sent on every page', paged.calls.every((c) => c.headers.Prefer === 'outlook.timezone="UTC"'));

    const endless = graphMock({ endlessNextLink: true, calendars: { [SAM]: [devPtoOnInvitee()] } });
    const capped  = await readPtoEvents(endless, SAM, WINDOW.start, WINDOW.end);
    check('stops after 10 pages (never loops forever)', endless.calls.length === 10, endless.calls.length);
    check('page cap hit → teammate PTO NOT removed (unseen events could be look-alikes)',
      capped.teammatePto.length === 0, capped.teammatePto);

    let threw = false;
    let failedRead;
    try { failedRead = await readPtoEvents(graphMock({ failGet: true }), DEV, WINDOW.start, WINDOW.end); }
    catch { threw = true; }
    check('Graph error → no throw, nothing found', !threw && failedRead.own.length === 0 && failedRead.teammatePto.length === 0);

    // Page 1 fine, page 2 fails → keep own PTO from page 1, but remove no teammate PTO.
    const flaky = graphMock({ calendars: { [DEV]: { pages: [[devPto(), devPtoOnInvitee({ organizer: OTHER })], [devPto()]] } } });
    const realApi = flaky.api.bind(flaky);
    flaky.api = (url) => {
      const req = realApi(url);
      if (url.includes('page=2')) req.get = async () => { throw new Error('timeout'); };
      return req;
    };
    const partial = await readPtoEvents(flaky, DEV, WINDOW.start, WINDOW.end);
    check('failure on a later page keeps own PTO already found', partial.own.length === 1, partial.own.length);
    check('…but removes no teammate PTO', partial.teammatePto.length === 0, partial.teammatePto);

    const none = [await readPtoEvents(null, DEV, WINDOW.start, WINDOW.end),
                  await readPtoEvents(graphMock(), '', WINDOW.start, WINDOW.end)];
    check('no client or no email → empty, without a call',
      none.every((r) => r.own.length === 0 && r.teammatePto.length === 0 && r.otherBusy.length === 0));
  });

  // ── Teammate PTO: matching free/busy blocks ────────────────────────────────
  await section('dropTeammatePto() — which free/busy block a teammate\'s PTO produced', () => {
    const span = (start, end, isAllDay = true) => ({ start: new Date(start), end: new Date(end), isAllDay });
    const block = (start, end, status = 'oof') => ({ start: new Date(start), end: new Date(end), status });
    const pto = span('2026-11-23T00:00:00Z', '2026-12-05T00:00:00Z');
    const drop = (blocks, ptos = [pto], others = []) => dropTeammatePto(blocks, ptos, others);

    check('Eastern mailbox (05:00 UTC) → removed',
      drop([block('2026-11-23T05:00:00Z', '2026-12-05T05:00:00Z')]).dropped === 1);
    check('Pacific mailbox (08:00 UTC) → removed',
      drop([block('2026-11-23T08:00:00Z', '2026-12-05T08:00:00Z')]).dropped === 1);
    check('mailbox east of UTC (India, 18:30 UTC the day before) → removed',
      drop([block('2026-11-22T18:30:00Z', '2026-12-04T18:30:00Z')]).dropped === 1);
    check('PTO across a clock change (04:00 start, 05:00 end) → removed',
      dropTeammatePto([block('2026-10-30T04:00:00Z', '2026-11-03T05:00:00Z')],
        [span('2026-10-30T00:00:00Z', '2026-11-03T00:00:00Z')], []).dropped === 1);
    check('timed teammate PTO → removed only on exact times',
      dropTeammatePto([block('2026-11-18T18:00:00Z', '2026-11-18T22:00:00Z')],
        [span('2026-11-18T18:00:00Z', '2026-11-18T22:00:00Z', false)], []).dropped === 1 &&
      dropTeammatePto([block('2026-11-18T18:30:00Z', '2026-11-18T22:00:00Z')],
        [span('2026-11-18T18:00:00Z', '2026-11-18T22:00:00Z', false)], []).dropped === 0);
    check('1-hour meeting on a PTO day → kept',
      drop([block('2026-11-24T15:00:00Z', '2026-11-24T16:00:00Z', 'busy')]).dropped === 0);
    check('all-day event on other dates → kept',
      drop([block('2026-11-24T05:00:00Z', '2026-11-25T05:00:00Z')]).dropped === 0);
    check('same length but 2 days off → kept',
      drop([block('2026-11-25T05:00:00Z', '2026-12-07T05:00:00Z')]).dropped === 0);
    check('ends shifted by different amounts (>1h) → kept',
      drop([block('2026-11-23T05:00:00Z', '2026-12-05T08:00:00Z')]).dropped === 0);
    check('your own non-PTO event with the exact same times → nothing removed (look-alike)',
      drop([block('2026-11-23T05:00:00Z', '2026-12-05T05:00:00Z')], [pto], [pto]).dropped === 0);
    check('two teammates on PTO the same days → both blocks removed',
      drop([block('2026-11-23T05:00:00Z', '2026-12-05T05:00:00Z'), block('2026-11-23T05:00:00Z', '2026-12-05T05:00:00Z')],
        [pto, pto]).dropped === 2);
    check('one teammate PTO removes only one of two identical blocks',
      drop([block('2026-11-23T05:00:00Z', '2026-12-05T05:00:00Z'), block('2026-11-23T05:00:00Z', '2026-12-05T05:00:00Z')])
        .kept.length === 1);
    const original = [block('2026-11-23T05:00:00Z', '2026-12-05T05:00:00Z')];
    drop(original);
    check('input list is not modified', original.length === 1);
  });

  // ── getFreeBusy: what every suggestion path receives ───────────────────────
  await section('getFreeBusy() — both PTO rules applied', async () => {
    // Dev organized the PTO (Free on his calendar). Sam was invited and it shows
    // as Out of Office on Sam's calendar, so getSchedule blocks Sam with it.
    const g = graphMock({
      schedules: {
        [DEV]: [schedItem('2026-11-17T15:00:00', '2026-11-17T16:00:00', 'busy')],
        [SAM]: [DEV_PTO_FREEBUSY_ET, SAM_MEETING],
      },
      calendars: {
        [DEV]: [devPto()],
        [SAM]: [devPtoOnInvitee(), event({ organizer: OTHER, isOrganizer: false, showAs: 'busy', allDay: false,
          attendees: [SAM], start: '2026-11-24T15:00:00Z', end: '2026-11-24T16:00:00Z' })],
      },
    });
    const { result, logs } = await capturingLogs(() => getFreeBusy(g, [DEV, SAM], WINDOW.start, WINDOW.end));
    const dev = result.find((p) => p.email === DEV);
    const sam = result.find((p) => p.email === SAM);
    check('Dev keeps the meeting getSchedule reported', dev?.busySlots.some((b) => b.status === 'busy'));
    check('Dev gets his own PTO block (Free PTO no longer invisible)',
      dev?.busySlots.some((b) => b.status === 'pto' && b.start.toISOString() === '2026-11-23T05:00:00.000Z'));
    check("Sam is no longer blocked by Dev's PTO",
      !sam?.busySlots.some((b) => b.end - b.start > 24 * 3600e3), sam?.busySlots);
    check("Sam keeps his real meeting on Dev's PTO day",
      sam?.busySlots.length === 1 && sam.busySlots[0].start.toISOString() === '2026-11-24T15:00:00.000Z', sam?.busySlots);
    check('one getSchedule call + one calendarView call per person',
      g.calls.filter((c) => c.kind === 'getSchedule').length === 1 &&
      g.calls.filter((c) => c.kind === 'calendarView').length === 2,
      g.calls.map((c) => c.kind));
    check('logs both actions', logs.some((l) => l.includes('PTO period')) && logs.some((l) => l.includes('teammate PTO')), logs);
    check('PRIVACY: logs never include an email address', logs.every((l) => !l.includes('@')), logs);

    const freeOnSam = graphMock({
      schedules: { [SAM]: [SAM_MEETING] },
      calendars: { [SAM]: [devPtoOnInvitee({ showAs: 'free' })] },
    });
    const unchanged = await getFreeBusy(freeOnSam, [SAM], WINDOW.start, WINDOW.end);
    check('teammate PTO showing as Free → result identical to plain free/busy',
      JSON.stringify(unchanged) === JSON.stringify(parseResponse({ value: [{ scheduleId: SAM, scheduleItems: [SAM_MEETING] }] })));

    const down = graphMock({ schedules: { [SAM]: [DEV_PTO_FREEBUSY_ET, SAM_MEETING] }, failGet: true });
    const degraded = await getFreeBusy(down, [DEV, SAM], WINDOW.start, WINDOW.end);
    const plain = parseResponse({ value: [
      { scheduleId: DEV, scheduleItems: [] },
      { scheduleId: SAM, scheduleItems: [DEV_PTO_FREEBUSY_ET, SAM_MEETING] },
    ] });
    check('calendarView down → exactly the plain free/busy result (today\'s behaviour)',
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
    const g = graphMock({
      schedules: { [SAM]: [DEV_PTO_FREEBUSY_ET] },
      calendars: { [DEV]: [devPto()], [SAM]: [devPtoOnInvitee()] },
    });
    const busy = await getFreeBusy(g, [DEV, SAM], WINDOW.start, WINDOW.end);

    for (const tz of ['America/New_York', 'America/Chicago', 'America/Los_Angeles']) {
      const slots = allSlots(busy, tz);
      const short = tz.split('/')[1].replace('_', ' ');
      const during = onPtoDays(slots, tz);
      check(`${short}: no slots on any PTO day`, during.length === 0, during.slice(0, 3).map((s) => s.start.toISOString()));
      check(`${short}: Fri Nov 20 (day before) still fully open, incl. 4:30 PM`,
        slots.some((s) => localDay(s.start, tz) === '2026-11-20' && localTime(s.start, tz) === '4:30 PM'));
      check(`${short}: Mon Dec 7 (back from PTO) open from 9:00 AM`,
        slots.some((s) => localDay(s.start, tz) === '2026-12-07' && localTime(s.start, tz) === '9:00 AM'));
    }

    // Without PTO handling (plain getSchedule), Dev's PTO days were wide open:
    const before = onPtoDays(allSlots(parseResponse({ value: [
      { scheduleId: DEV, scheduleItems: [] }, { scheduleId: SAM, scheduleItems: [] }] })));
    check(`(before this fix the same calendars offered ${before.length} slots during the PTO)`, before.length > 0);
  });

  await section("slots — Sam & Alex (Dev's PTO shows as Out of Office on Sam's calendar)", async () => {
    const g = graphMock({
      schedules: { [SAM]: [DEV_PTO_FREEBUSY_ET, SAM_MEETING] },
      calendars: { [SAM]: [devPtoOnInvitee(), event({ organizer: OTHER, isOrganizer: false, showAs: 'busy',
        allDay: false, attendees: [SAM], start: '2026-11-24T15:00:00Z', end: '2026-11-24T16:00:00Z' })] },
    });
    const slots = allSlots(await getFreeBusy(g, [SAM, ALEX], WINDOW.start, WINDOW.end));
    const during = onPtoDays(slots);
    const before = onPtoDays(allSlots(parseResponse({ value: [
      { scheduleId: SAM, scheduleItems: [DEV_PTO_FREEBUSY_ET, SAM_MEETING] }, { scheduleId: ALEX, scheduleItems: [] }] })));
    check(`(before this fix: ${before.length} slots on those 10 days)`, before.length === 0, before.length);
    check(`now: Sam & Alex get slots on those days (${during.length})`, during.length > 100, during.length);
    check("Sam's real meeting (Tue Nov 24, 10–11 AM) still blocked",
      !slots.some((s) => s.start.toISOString() === '2026-11-24T15:00:00.000Z' || s.start.toISOString() === '2026-11-24T15:30:00.000Z'));
  });

  await section('suggestMeetingTimes() — wiring (starter suggestions)', async () => {
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const rangeStart = iso(now - 24 * 3600e3);
    const rangeEnd   = iso(now + 30 * 24 * 3600e3);
    // Timed PTO covering the whole suggestion range (yesterday → +30 days).
    const longPto = (organizer, isOrganizer, showAs = 'free') =>
      event({ organizer, isOrganizer, showAs, allDay: false, start: rangeStart, end: rangeEnd });
    const longPtoFreeBusy = schedItem(rangeStart.replace('Z', ''), rangeEnd.replace('Z', ''), 'oof');
    const users = (a, b) => [
      { slack_user_id: 'U_PTO_A', display_name: 'A', slack_email: a, ms_timezone: ET },
      { slack_user_id: 'U_PTO_B', display_name: 'B', slack_email: b, ms_timezone: ET },
    ];
    const settings = { calendar_enabled: 1, meeting_duration: 15, calendar_timezone: ET };
    const slack = () => {
      const posts = [];
      return { posts, chat: {
        postMessage:   async (m) => { posts.push(m); return { ts: '1.1' }; },
        postEphemeral: async (m) => { posts.push(m); return {}; },
      } };
    };
    const buttonsIn = (post) => post?.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements) ?? [];

    schedulerGraph = graphMock({ calendars: { [DEV]: [longPto(DEV, true)] } });
    const onPto = slack();
    await suggestMeetingTimes(onPto, 'C_PTO_TEST', -1, users(DEV, SAM), settings);
    check('Dev on PTO for the whole range → "couldn\'t find a time" notice, no buttons',
      onPto.posts.length === 1 && onPto.posts[0].text.includes("couldn't find") && buttonsIn(onPto.posts[0]).length === 0,
      onPto.posts.map((p) => p.text));

    schedulerGraph = graphMock({
      schedules: { [SAM]: [longPtoFreeBusy] },
      calendars: { [SAM]: [longPto(DEV, false, 'oof')] },
    });
    const teammate = slack();
    await suggestMeetingTimes(teammate, 'C_PTO_TEST', -1, users(SAM, ALEX), settings);
    check("Dev's PTO showing as Out of Office on Sam's calendar → Sam & Alex still get 3 suggestions",
      buttonsIn(teammate.posts[0]).length === 3, teammate.posts.map((p) => p.text));
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
