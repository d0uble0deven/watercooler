'use strict';

// Reads free/busy data from Microsoft Graph for a set of users.
//
// Two reads, both app-only (no per-user login) under the Calendars.Read
// application permission. See docs/OUTLOOK_INTEGRATION.md for setup.
//   1. POST /users/{id}/calendar/getSchedule — free/busy blocks for everyone
//      in a single request.
//   2. GET /users/{id}/calendarView, once per person — only to find that
//      person's own PTO, which is usually marked Free and so invisible to (1).
//      See "PTO detection" below.
//
// Returns a normalised array of busy slots per user.
// Never throws — returns an empty array on any error so the caller can degrade
// gracefully (e.g. skip calendar check for a user who has no email set).

const config = require('../config');

// Statuses that block a time slot from being offered as a meeting time.
// 'free' and 'workingElsewhere' are treated as available.
const BLOCKING = new Set(['busy', 'tentative', 'oof']);

// Tentative blocks at least this long are all-day or multi-day entries, not
// real meetings — typically company-wide invites nobody has answered yet,
// which Outlook shows as tentative. Round 10 (Sep 2026) lost 13 of 17 match
// suggestions to two such invites spanning the entire search window.
// 23h rather than 24h so an all-day event on a spring-forward DST day counts.
// busy and oof blocks are never skipped: a multi-day OOF is a real absence.
const ALL_DAY_TENTATIVE_MS = 23 * 60 * 60 * 1000;

/**
 * Fetches the busy/free schedule for a list of user email addresses
 * within a given time window.
 *
 * @param {object}   graphClient  MS Graph client from msGraph.getGraphClient()
 * @param {string[]} emails       Email addresses to query (must be in the same tenant)
 * @param {Date}     windowStart  Start of the search window (JS Date, UTC)
 * @param {Date}     windowEnd    End of the search window   (JS Date, UTC)
 * @param {string}   [timezoneId] Windows/IANA timezone name for the request (default: 'UTC')
 *
 * @returns {Promise<Array<{
 *   email:     string,
 *   busySlots: Array<{ start: Date, end: Date, status: string }>
 * }>>}
 *
 * busySlots contains BLOCKING entries (busy / tentative / oof) plus 'pto'
 * entries for each person's own PTO (see "PTO detection").
 * Dates are always JS Date objects in UTC.
 */
async function getFreeBusy(graphClient, emails, windowStart, windowEnd, timezoneId = 'UTC') {
  if (!graphClient || !emails || emails.length === 0) return [];

  const body = {
    schedules:  emails,
    startTime:  { dateTime: toGraphDateTime(windowStart), timeZone: timezoneId },
    endTime:    { dateTime: toGraphDateTime(windowEnd),   timeZone: timezoneId },
    // 30-minute resolution is enough for slot-finding
    availabilityViewInterval: 30,
  };

  // getSchedule requires a user context — we anchor on the first email.
  // With Calendars.Read app-only permission, any licensed user works here.
  let response;
  try {
    response = await graphClient
      .api(`/users/${encodeURIComponent(emails[0])}/calendar/getSchedule`)
      .post(body);
  } catch (err) {
    console.error('[calendarReader] getSchedule call failed:', err.message);
    return emails.map((email) => ({ email, busySlots: [] }));
  }

  return addOwnPtoBlocks(graphClient, parseResponse(response), windowStart, windowEnd);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts a JS Date to the "local" dateTime string the Graph API expects:
 *   "2024-01-15T10:00:00"  (no milliseconds, no trailing Z — timezone passed separately)
 */
function toGraphDateTime(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, '');
}

/**
 * Normalises a raw getSchedule response value into:
 *   [{ email, busySlots: [{ start, end, status }] }]
 *
 * Graph returns datetimes without a Z suffix even when timeZone is UTC,
 * so we append 'Z' before parsing to get correct JS Date values.
 *
 * Graph may return up to 7 decimal places on seconds (e.g. "10:00:00.0000000")
 * — the JS Date constructor handles that correctly.
 *
 * All-day and multi-day tentative entries are dropped (see ALL_DAY_TENTATIVE_MS).
 */
function parseResponse(response) {
  const items = response?.value ?? [];

  return items.map((item) => ({
    email:     item.scheduleId,
    busySlots: (item.scheduleItems ?? [])
      .filter((s) => BLOCKING.has((s.status ?? '').toLowerCase()))
      .map((s) => ({
        start:  new Date(s.start.dateTime + 'Z'),
        end:    new Date(s.end.dateTime   + 'Z'),
        status: (s.status).toLowerCase(),
      }))
      .filter((s) => !(s.status === 'tentative' && s.end - s.start >= ALL_DAY_TENTATIVE_MS)),
  }));
}

// ── PTO detection ─────────────────────────────────────────────────────────────
// DocMe360 convention: time off goes out as an invite that includes
// pto@docme360.com (config.ptoAttendeeAddress), usually marked "Free" so it
// doesn't block teammates' calendars. getSchedule therefore can't see it: in
// Nov 2026, 8 of 9 upcoming PTO events were Free on their owner's own calendar,
// and the bot offered times in the middle of people's vacations.
//
// Rule: an event a person ORGANIZED that invites the PTO address is their time
// off, however it's marked. Someone else's PTO on your calendar is never added
// here (what getSchedule reports for it is unchanged).
//
// Privacy: $select leaves out subject and body — event titles are never read.
// Attendee addresses are compared in memory only; never logged or stored.

const CALENDAR_VIEW_FIELDS    = 'organizer,attendees,start,end,isAllDay,isCancelled,isOrganizer';
const CALENDAR_VIEW_PAGE_SIZE = 100;
// 1,000 events. The busiest calendar in Nov 2026 needed 2 pages for 3 weeks.
const CALENDAR_VIEW_MAX_PAGES = 10;

/**
 * Adds each person's own PTO to their busySlots. One calendarView read per
 * person, in parallel. Never throws (see getOwnPtoBlocks).
 *
 * @param {object} graphClient
 * @param {Array<{ email: string, busySlots: object[] }>} busyData  From parseResponse
 * @param {Date}   windowStart
 * @param {Date}   windowEnd
 * @returns {Promise<Array<{ email: string, busySlots: object[] }>>}
 */
async function addOwnPtoBlocks(graphClient, busyData, windowStart, windowEnd) {
  return Promise.all(busyData.map(async (person) => {
    const ptoBlocks = await getOwnPtoBlocks(graphClient, person.email, windowStart, windowEnd);
    if (ptoBlocks.length === 0) return person;
    console.log(
      `[calendarReader] Blocking ${ptoBlocks.length} PTO period(s) from a participant's own PTO invite.`,
    );
    return { ...person, busySlots: [...person.busySlots, ...ptoBlocks] };
  }));
}

/**
 * Returns [{ start, end, status: 'pto' }] for every PTO event `email`
 * organized that overlaps the window (calendarView includes events that
 * started earlier and are still running).
 *
 * Never throws: on failure it logs and keeps whatever it found, so a Graph
 * hiccup degrades to plain free/busy instead of blocking suggestions.
 *
 * @param {object} graphClient
 * @param {string} email
 * @param {Date}   windowStart
 * @param {Date}   windowEnd
 * @returns {Promise<Array<{ start: Date, end: Date, status: 'pto' }>>}
 */
async function getOwnPtoBlocks(graphClient, email, windowStart, windowEnd) {
  if (!graphClient || !email) return [];

  let url =
    `/users/${encodeURIComponent(email)}/calendarView` +
    `?startDateTime=${encodeURIComponent(windowStart.toISOString())}` +
    `&endDateTime=${encodeURIComponent(windowEnd.toISOString())}` +
    `&$select=${CALENDAR_VIEW_FIELDS}` +
    `&$top=${CALENDAR_VIEW_PAGE_SIZE}`;

  const blocks = [];
  let pages = 0;
  try {
    while (url && pages < CALENDAR_VIEW_MAX_PAGES) {
      // Timed events come back in UTC. All-day events have no zone of their
      // own — see toPtoBlock.
      const res = await graphClient.api(url).header('Prefer', 'outlook.timezone="UTC"').get();
      pages++;
      for (const event of res?.value ?? []) {
        if (!isOwnPtoEvent(event, email)) continue;
        const block = toPtoBlock(event);
        if (block) blocks.push(block);
      }
      url = res?.['@odata.nextLink'] ?? null;
    }
    if (url) {
      console.warn(
        `[calendarReader] PTO lookup stopped after ${CALENDAR_VIEW_MAX_PAGES} pages — later events not checked.`,
      );
    }
  } catch (err) {
    console.error('[calendarReader] PTO lookup failed — continuing with free/busy only:', err.message);
  }
  return blocks;
}

/**
 * True when `event` is the calendar owner's own PTO: not cancelled, organized
 * by the owner, and inviting the PTO address.
 *
 * Ownership uses Graph's isOrganizer flag, with the organizer address as a
 * backup. In Nov 2026 the two agreed on every PTO event checked.
 *
 * @param {object} event       calendarView event
 * @param {string} ownerEmail  Whose calendar the event came from
 * @returns {boolean}
 */
function isOwnPtoEvent(event, ownerEmail) {
  if (!event || event.isCancelled) return false;

  const ptoAddress = (config.ptoAttendeeAddress ?? '').toLowerCase();
  if (!ptoAddress) return false;

  const owner     = (ownerEmail ?? '').toLowerCase();
  const organizer = (event.organizer?.emailAddress?.address ?? '').toLowerCase();
  const isOwn     = event.isOrganizer === true || (owner !== '' && organizer === owner);
  if (!isOwn) return false;

  return (event.attendees ?? []).some(
    (a) => (a?.emailAddress?.address ?? '').toLowerCase() === ptoAddress,
  );
}

/**
 * Converts a PTO event to a busy block, or null if its dates are unreadable.
 *
 * All-day events have no time zone of their own: Graph returns them as
 * midnight-to-midnight in whatever zone was requested (00:00 UTC here).
 * They're anchored to midnight in the org timezone instead, which is where
 * getSchedule places all-day events on Eastern mailboxes (05:00 UTC, verified
 * Nov 2026). Eastern midnight-to-midnight covers the whole working day in every
 * US timezone; UTC midnight would leave 4–5 PM Pacific open on the last day.
 *
 * @param {object} event  calendarView event
 * @returns {{ start: Date, end: Date, status: 'pto' } | null}
 */
function toPtoBlock(event) {
  const startRaw = event.start?.dateTime;
  const endRaw   = event.end?.dateTime;
  if (!startRaw || !endRaw) return null;

  const start = event.isAllDay
    ? midnightInTimezone(startRaw.slice(0, 10), config.calendarTimezone)
    : parseGraphUtc(startRaw);
  const end = event.isAllDay
    ? midnightInTimezone(endRaw.slice(0, 10), config.calendarTimezone)
    : parseGraphUtc(endRaw);

  if (isNaN(start) || isNaN(end) || end <= start) return null;
  return { start, end, status: 'pto' };
}

/** Graph UTC dateTime ("2026-11-23T14:00:00.0000000", no Z) → Date. */
function parseGraphUtc(dateTime) {
  return new Date(/(Z|[+-]\d\d:?\d\d)$/.test(dateTime) ? dateTime : `${dateTime}Z`);
}

/**
 * The UTC instant of 00:00 on `dateKey` ("YYYY-MM-DD") in `timezoneId`,
 * DST-aware: midnight Eastern is 05:00 UTC in winter and 04:00 UTC in summer.
 */
function midnightInTimezone(dateKey, timezoneId) {
  const naive = new Date(`${dateKey}T00:00:00Z`);
  // Two passes: the second corrects for a DST change between the two instants.
  let guess = naive.getTime() - utcOffsetMs(naive, timezoneId);
  guess = naive.getTime() - utcOffsetMs(new Date(guess), timezoneId);
  return new Date(guess);
}

/** How far `timezoneId`'s wall clock is ahead of UTC at `date` (ms; negative in the US). */
function utcOffsetMs(date, timezoneId) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezoneId, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const wallClockAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  return wallClockAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

module.exports = { getFreeBusy, toGraphDateTime, parseResponse, getOwnPtoBlocks, isOwnPtoEvent };
