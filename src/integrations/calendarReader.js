'use strict';

// Reads free/busy data from Microsoft Graph for a set of users.
//
// Two reads, both app-only (no per-user login) under the Calendars.Read
// application permission. See docs/OUTLOOK_INTEGRATION.md for setup.
//   1. POST /users/{id}/calendar/getSchedule — free/busy blocks for everyone
//      in a single request.
//   2. GET /users/{id}/calendarView, once per person — only to get PTO
//      right, which (1) can't do on its own. See "PTO handling" below.
//
// Returns a normalised array of busy slots per user.
// Never throws — returns an empty array on any error so the caller can degrade
// gracefully (e.g. skip calendar check for a user who has no email set).

const config = require('../config');
const { zonedTime } = require('../lib/timezone');

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
 * entries for each person's own PTO, minus blocks from teammates' PTO
 * (see "PTO handling").
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

  return applyPto(graphClient, parseResponse(response), windowStart, windowEnd);
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

// ── PTO handling ──────────────────────────────────────────────────────────────
// DocMe360 convention: time off goes out as an invite that includes
// pto@docme360.com (config.ptoAttendeeAddress), usually marked "Free".
// Free/busy (getSchedule) gets PTO wrong both ways:
//
//   1. Your own PTO is invisible when it's marked Free — in Nov 2026, 8 of 9
//      upcoming PTO events were, and the bot offered times mid-vacation.
//      Fix: an event a person ORGANIZED that invites the PTO address blocks
//      them, however it's marked.
//
//   2. A teammate's PTO you were invited to can block YOU when it shows as
//      busy or out of office on your calendar — in Nov 2026 one person's PTO
//      blocked 3 coworkers for 19 days.
//      Fix: that free/busy block is removed. A teammate's PTO never blocks you.
//
// Both come from one calendarView read per person.
// Privacy: $select leaves out subject and body — event titles are never read.
// Attendee addresses are compared in memory only; never logged or stored.

const CALENDAR_VIEW_FIELDS    = 'organizer,attendees,start,end,isAllDay,isCancelled,isOrganizer,showAs';
const CALENDAR_VIEW_PAGE_SIZE = 100;
// 1,000 events. The busiest calendar in Nov 2026 needed 2 pages for 3 weeks.
const CALENDAR_VIEW_MAX_PAGES = 10;

const HOUR_MS = 60 * 60 * 1000;
// UTC offsets run from -12h to +14h.
const MAX_UTC_OFFSET_MS = 14 * HOUR_MS;

/**
 * Applies both PTO rules to each person's busySlots. One calendarView read
 * per person, in parallel. Never throws (see readPtoEvents).
 *
 * @param {object} graphClient
 * @param {Array<{ email: string, busySlots: object[] }>} busyData  From parseResponse
 * @param {Date}   windowStart
 * @param {Date}   windowEnd
 * @returns {Promise<Array<{ email: string, busySlots: object[] }>>}
 */
async function applyPto(graphClient, busyData, windowStart, windowEnd) {
  return Promise.all(busyData.map(async (person) => {
    const pto = await readPtoEvents(graphClient, person.email, windowStart, windowEnd);
    const { kept, dropped } = dropTeammatePto(person.busySlots, pto.teammatePto, pto.otherBusy);

    if (pto.own.length === 0 && dropped === 0) return person;
    if (pto.own.length > 0) {
      console.log(`[calendarReader] Blocking ${pto.own.length} PTO period(s) from a participant's own PTO invite.`);
    }
    if (dropped > 0) {
      console.log(`[calendarReader] Ignoring ${dropped} teammate PTO block(s) on a participant's calendar.`);
    }
    return { ...person, busySlots: [...kept, ...pto.own] };
  }));
}

/**
 * Reads one person's events in the window (calendarView includes events that
 * started earlier and are still running) and sorts out what PTO needs:
 *
 *   own          [{ start, end, status: 'pto' }]  their own PTO, as busy blocks
 *   teammatePto  [{ start, end, isAllDay }]       teammates' PTO showing as
 *                                                 busy/tentative/OOF on their calendar
 *   otherBusy    [{ start, end, isAllDay }]       their other non-free events
 *                                                 (guards against false matches)
 *
 * Spans are Graph's own times: all-day events stay at 00:00 UTC (floating).
 *
 * Never throws: on failure it logs and keeps the own PTO found so far, so a
 * Graph hiccup degrades to plain free/busy. Teammate PTO is only returned when
 * the read was complete, since an unseen event could be a look-alike.
 *
 * @param {object} graphClient
 * @param {string} email
 * @param {Date}   windowStart
 * @param {Date}   windowEnd
 */
async function readPtoEvents(graphClient, email, windowStart, windowEnd) {
  const result = { own: [], teammatePto: [], otherBusy: [] };
  if (!graphClient || !email) return result;

  let url =
    `/users/${encodeURIComponent(email)}/calendarView` +
    `?startDateTime=${encodeURIComponent(windowStart.toISOString())}` +
    `&endDateTime=${encodeURIComponent(windowEnd.toISOString())}` +
    `&$select=${CALENDAR_VIEW_FIELDS}` +
    `&$top=${CALENDAR_VIEW_PAGE_SIZE}`;

  let pages = 0;
  let complete = false;
  try {
    while (url && pages < CALENDAR_VIEW_MAX_PAGES) {
      // Timed events come back in UTC. All-day events have no zone of their
      // own — see toPtoBlock.
      const res = await graphClient.api(url).header('Prefer', 'outlook.timezone="UTC"').get();
      pages++;
      for (const event of res?.value ?? []) sortEvent(event, email, result);
      url = res?.['@odata.nextLink'] ?? null;
    }
    complete = !url;
    if (!complete) {
      console.warn(
        `[calendarReader] PTO lookup stopped after ${CALENDAR_VIEW_MAX_PAGES} pages — later events not checked.`,
      );
    }
  } catch (err) {
    console.error('[calendarReader] PTO lookup failed — continuing with free/busy only:', err.message);
  }

  if (!complete) result.teammatePto = [];
  return result;
}

/** Files one calendarView event into readPtoEvents' result. */
function sortEvent(event, ownerEmail, result) {
  if (!event || event.isCancelled) return;

  if (isOwnPtoEvent(event, ownerEmail)) {
    const block = toPtoBlock(event);
    if (block) result.own.push(block);
    return;
  }

  // Only non-free events can have produced a free/busy block.
  if (!BLOCKING.has((event.showAs ?? '').toLowerCase())) return;
  const span = graphSpan(event);
  if (!span) return;
  if (invitesPto(event)) result.teammatePto.push(span);
  else result.otherBusy.push(span);
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

  const owner     = (ownerEmail ?? '').toLowerCase();
  const organizer = (event.organizer?.emailAddress?.address ?? '').toLowerCase();
  const isOwn     = event.isOrganizer === true || (owner !== '' && organizer === owner);
  return isOwn && invitesPto(event);
}

/** True when the PTO address is among the event's attendees. */
function invitesPto(event) {
  const ptoAddress = (config.ptoAttendeeAddress ?? '').toLowerCase();
  if (!ptoAddress) return false;
  return (event?.attendees ?? []).some(
    (a) => (a?.emailAddress?.address ?? '').toLowerCase() === ptoAddress,
  );
}

/**
 * Removes the free/busy block each teammate PTO event produced.
 *
 * Matching: timed events have the same UTC times in both APIs. All-day events
 * don't — calendarView returns them at 00:00 UTC, while getSchedule anchors
 * them at midnight in the mailbox's own timezone (05:00 UTC for Eastern, and
 * it never clips them to the query window — both verified Nov 2026). So an
 * all-day match is a block shifted by one consistent UTC offset at both ends
 * (allowing 1h for a DST change in between).
 *
 * Each event removes at most one block. If the person has a non-PTO event with
 * exactly the same times, free/busy can't tell the two apart, so nothing is
 * removed — it keeps blocking, as before.
 *
 * @param {object[]} busySlots    From parseResponse
 * @param {object[]} teammatePto  From readPtoEvents
 * @param {object[]} otherBusy    From readPtoEvents
 * @returns {{ kept: object[], dropped: number }}
 */
function dropTeammatePto(busySlots, teammatePto, otherBusy) {
  const kept = [...busySlots];
  let dropped = 0;
  for (const span of teammatePto) {
    if (otherBusy.some((other) => sameSpan(other, span))) continue;
    const i = kept.findIndex((block) => blockMatchesSpan(block, span));
    if (i === -1) continue;
    kept.splice(i, 1);
    dropped++;
  }
  return { kept, dropped };
}

function blockMatchesSpan(block, span) {
  if (!span.isAllDay) {
    return block.start.getTime() === span.start.getTime() && block.end.getTime() === span.end.getTime();
  }
  const startShift = block.start - span.start;
  const endShift   = block.end - span.end;
  return Math.abs(startShift) <= MAX_UTC_OFFSET_MS && Math.abs(endShift - startShift) <= HOUR_MS;
}

function sameSpan(a, b) {
  return a.isAllDay === b.isAllDay &&
    a.start.getTime() === b.start.getTime() && a.end.getTime() === b.end.getTime();
}

/** An event's times as Graph returned them (all-day stays at 00:00 UTC), or null. */
function graphSpan(event) {
  const startRaw = event.start?.dateTime;
  const endRaw   = event.end?.dateTime;
  if (!startRaw || !endRaw) return null;
  const start = parseGraphUtc(startRaw);
  const end   = parseGraphUtc(endRaw);
  if (isNaN(start) || isNaN(end) || end <= start) return null;
  return { start, end, isAllDay: event.isAllDay === true };
}

/**
 * Converts an own-PTO event to a busy block, or null if its dates are unreadable.
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
  const span = graphSpan(event);
  if (!span) return null;
  if (!span.isAllDay) return { start: span.start, end: span.end, status: 'pto' };

  const start = zonedTime(event.start.dateTime.slice(0, 10), 0, 0, config.calendarTimezone);
  const end   = zonedTime(event.end.dateTime.slice(0, 10), 0, 0, config.calendarTimezone);
  return { start, end, status: 'pto' };
}

/** Graph UTC dateTime ("2026-11-23T14:00:00.0000000", no Z) → Date. */
function parseGraphUtc(dateTime) {
  return new Date(/(Z|[+-]\d\d:?\d\d)$/.test(dateTime) ? dateTime : `${dateTime}Z`);
}

module.exports = {
  getFreeBusy, toGraphDateTime, parseResponse,
  readPtoEvents, isOwnPtoEvent, dropTeammatePto,
};
