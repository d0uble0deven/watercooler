'use strict';

// Reads free/busy data from Microsoft Graph for a set of users.
//
// Uses POST /users/{id}/calendar/getSchedule which works with app-only auth
// (no per-user login). IT must have granted Calendars.Read permission on the
// Azure AD app registration. See docs/OUTLOOK_INTEGRATION.md for setup.
//
// Returns a normalised array of busy slots per user.
// Never throws — returns an empty array on any error so the caller can degrade
// gracefully (e.g. skip calendar check for a user who has no email set).

// Statuses that block a time slot from being offered as a meeting time.
// 'free' and 'workingElsewhere' are treated as available.
const BLOCKING = new Set(['busy', 'tentative', 'oof']);

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
 * busySlots contains only BLOCKING entries (busy / tentative / oof).
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

  return parseResponse(response);
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
      })),
  }));
}

module.exports = { getFreeBusy, toGraphDateTime, parseResponse };
