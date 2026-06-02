'use strict';

// Orchestrates the calendar-suggestion flow for a match group:
//
//   1. Resolve each participant's email (from DB cache or Slack users.info).
//   2. Query Microsoft Graph for free/busy data over the next 5 business days.
//   3. Find up to 3 slots when everyone is free.
//   4. Post an interactive Block Kit message with booking buttons to the match DM.
//
// The `suggestMeetingTimes` entry point is called by `admin/run.js` right after
// the intro DM is sent. Every failure mode is caught and logged — a calendar
// error must never prevent the round from completing.
//
// Prerequisites (for the live path):
//   • AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET in .env
//   • CALENDAR_ENABLED=true in .env (or set via admin command)
//   • Slack app has the `users:read.email` scope (add in api.slack.com → OAuth & Permissions)

const config               = require('../config');
const { getGraphClient }   = require('./msGraph');
const { getFreeBusy }      = require('./calendarReader');
const { findSlots, findSlotsWithPrimePreference } = require('../lib/slotFinder');
const { saveUserEmail, saveUserTimezone, updateUser } = require('../lib/users');
const { saveSuggestionTs }          = require('../lib/rounds');

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Fetches free/busy data for a match group, finds open slots, and posts a
 * Block Kit message with booking buttons to the match DM channel.
 *
 * Silently skips (logs only) when:
 *   - calendar_enabled is false in DB settings
 *   - Azure credentials are missing
 *   - Any participant's email cannot be resolved
 *   - No shared free slots are found in the search window
 *
 * @param {object}   client     Bolt Web API client
 * @param {string}   channelId  Slack DM channel ID for this match group
 * @param {number}   matchId    DB match ID (encoded in button values for Step 6)
 * @param {object[]} users      Array of user rows from the DB
 * @param {object}   settings   App settings row (calendar_enabled, meeting_duration)
 * @param {boolean}  testMode   When true, adds a test disclaimer to the posted message
 */
async function suggestMeetingTimes(client, channelId, matchId, users, settings, testMode = false) {
  // ── Guard: feature flags ──────────────────────────────────────────────────
  if (!settings.calendar_enabled) return;

  const graphClient = getGraphClient();
  if (!graphClient) {
    console.warn('[calendarScheduler] Azure credentials missing — skipping suggestions.');
    return;
  }

  // ── Resolve emails ────────────────────────────────────────────────────────
  const emails = await resolveEmails(client, users);
  if (emails.length < users.length) {
    const missing = users.length - emails.length;
    console.warn(`[calendarScheduler] ${missing} user(s) missing email — skipping suggestions for match ${matchId}.`);
    return;
  }

  // ── Resolve per-user timezones + compute shared-hours intersection ────────
  // participantTzs: IANA strings for each user whose M365 timezone we know.
  // intersection:   UTC hour bounds covering the hours all participants share.
  // Falls back to orgTz (null intersection) when timezones can't be resolved.
  const orgTz          = settings.calendar_timezone ?? config.calendarTimezone;
  const participantTzs = await resolveTimezones(graphClient, users);
  const intersection   = computeIntersection(participantTzs, new Date());

  if (intersection) {
    const tzList = participantTzs.join(', ');
    console.log(`[calendarScheduler] Timezone intersection for match ${matchId} (${tzList}):`,
      `workday ${intersection.workdayStartHour}–${intersection.workdayEndHour} UTC, ` +
      `prime ${intersection.primeStartHour}–${intersection.primeEndHour} UTC`);
  } else {
    console.log(`[calendarScheduler] No timezone intersection — using org timezone (${orgTz}).`);
  }

  // ── Build near and far search windows ────────────────────────────────────
  // Near: +2 to +4 business days (e.g. Mon match → Wed–Fri same week)
  // Far:  +5 to +9 business days (e.g. Mon match → following Mon–Fri)
  // When an intersection is available the windows start/end at the shared UTC
  // hours rather than 9 AM / 5 PM in the org timezone.
  const near = buildNearWindow(new Date(), orgTz, intersection);
  const far  = buildFarWindow(new Date(), orgTz, intersection);

  // ── Free/busy query (single call covers both windows) ────────────────────
  const busyData = await getFreeBusy(graphClient, emails, near.start, far.end);

  // ── Slot finding ──────────────────────────────────────────────────────────
  // 2 slots from the near window  — prime time preferred, ≥ 2 h apart
  // 1 slot  from the far window   — prime time preferred, no gap constraint
  // With an intersection: checks run in UTC using computed UTC hour bounds.
  // Without one: checks run in orgTz with standard 9–17 / 11–15 defaults.
  const durationMinutes = settings.meeting_duration ?? 30;
  const slotTz          = intersection?.timezoneId ?? orgTz;
  const slotOptions     = intersection ?? {};

  const nearSlots = findSlotsWithPrimePreference(
    busyData, near.start, near.end, durationMinutes, 2, slotTz, 120, slotOptions,
  );
  const farSlots = findSlotsWithPrimePreference(
    busyData, far.start,  far.end,  durationMinutes, 1, slotTz,   0, slotOptions,
  );

  const slots = [...nearSlots, ...farSlots];

  if (slots.length === 0) {
    console.log(`[calendarScheduler] No shared free slots found for match ${matchId} — skipping suggestions.`);
    return;
  }

  // ── Post interactive message ──────────────────────────────────────────────
  // Display times in the shared local timezone when everyone is co-located
  // (e.g. two Chicago users see CDT, not EDT). Mixed timezones fall back to orgTz.
  const displayTz = pickDisplayTimezone(participantTzs, orgTz);
  const blocks = buildSuggestionsMessage(slots, matchId, displayTz, testMode);

  try {
    const result = await client.chat.postMessage({
      channel: channelId,
      text:    '📅 Here are some times that work for your meeting!',  // fallback for notifications
      blocks,
    });
    // Store the message ts so the auto-booker can update this message in-place
    if (result?.ts) saveSuggestionTs(matchId, result.ts);
    console.log(`[calendarScheduler] Posted ${slots.length} slot suggestion(s) for match ${matchId}.`);
  } catch (err) {
    console.error(`[calendarScheduler] Failed to post suggestions for match ${matchId}:`, err.message);
  }
}

// ── Email resolution ──────────────────────────────────────────────────────────

/**
 * Returns an email address for each user.
 * Uses the cached `slack_email` column first; falls back to calling Slack's
 * `users.info` endpoint (requires the `users:read.email` OAuth scope).
 *
 * Returns only the emails that were successfully resolved — callers check
 * whether the count matches `users.length`.
 */
async function resolveEmails(client, users) {
  const emails = [];

  for (const user of users) {
    if (user.slack_email) {
      emails.push(user.slack_email);
      continue;
    }

    try {
      const result = await client.users.info({ user: user.slack_user_id });
      const email  = result?.user?.profile?.email;

      if (email) {
        saveUserEmail(user.slack_user_id, email);  // cache for future rounds

        // Also refresh display name to real name — heals username-style names
        // (e.g. "dev.govindji" → "Dev Govindji") without requiring a re-join
        const realName = result?.user?.profile?.real_name
                      || result?.user?.profile?.display_name;
        if (realName && realName !== user.display_name) {
          updateUser(user.slack_user_id, { display_name: realName });
          console.log(`[calendarScheduler] Updated display name for ${user.slack_user_id}: "${user.display_name}" → "${realName}"`);
        }

        emails.push(email);
      } else {
        console.warn(
          `[calendarScheduler] No email in Slack profile for ${user.slack_user_id}. ` +
          'Ensure the Slack app has the users:read.email OAuth scope.'
        );
      }
    } catch (err) {
      console.warn(`[calendarScheduler] users.info failed for ${user.slack_user_id}:`, err.message);
    }
  }

  return emails;
}

// ── Windows → IANA timezone mapping ──────────────────────────────────────────
// M365 mailboxSettings returns Windows timezone names (e.g. "Central Standard Time").
// Node's Intl requires IANA names, so we translate here.
// Windows uses the same name year-round regardless of DST — that's fine because
// Intl.DateTimeFormat + IANA handles the actual DST transitions for us.
// Reference: https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/default-time-zones

const WINDOWS_TO_IANA = {
  // ── United States ──────────────────────────────────────────────────────────
  'Eastern Standard Time':         'America/New_York',
  'Central Standard Time':         'America/Chicago',
  'Mountain Standard Time':        'America/Denver',
  'US Mountain Standard Time':     'America/Phoenix',    // Arizona — no DST
  'Pacific Standard Time':         'America/Los_Angeles',
  'Alaska Standard Time':          'America/Anchorage',
  'Hawaii-Aleutian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time':        'America/Halifax',
  // ── Common international ───────────────────────────────────────────────────
  'UTC':                           'UTC',
  'GMT Standard Time':             'Europe/London',
  'W. Europe Standard Time':       'Europe/Berlin',
  'Central Europe Standard Time':  'Europe/Budapest',
  'Romance Standard Time':         'Europe/Paris',
  'India Standard Time':           'Asia/Kolkata',
};

// ── Timezone resolution ───────────────────────────────────────────────────────

/**
 * Returns an IANA timezone string for each user, reading the cached `ms_timezone`
 * DB column when available or fetching from Graph `/mailboxSettings` on first run.
 *
 * A missing or unrecognised timezone is silently skipped — the caller falls
 * back to the org-wide timezone for that user.
 *
 * @param {object}   graphClient  MS Graph client
 * @param {object[]} users        DB user rows (.slack_user_id, .slack_email, .ms_timezone)
 * @returns {Promise<string[]>}   IANA timezone strings (only successfully resolved entries)
 */
async function resolveTimezones(graphClient, users) {
  const timezones = [];

  for (const user of users) {
    // Already cached — use it directly without a Graph call
    if (user.ms_timezone) {
      timezones.push(user.ms_timezone);
      continue;
    }

    // Need an email address to query Graph
    if (!user.slack_email) {
      console.warn(`[calendarScheduler] No email for ${user.slack_user_id} — cannot fetch timezone.`);
      continue;
    }

    try {
      const settings  = await graphClient
        .api(`/users/${encodeURIComponent(user.slack_email)}/mailboxSettings`)
        .get();

      const windowsTz = settings?.timeZone;
      const ianaTz    = windowsTz ? (WINDOWS_TO_IANA[windowsTz] ?? null) : null;

      if (ianaTz) {
        saveUserTimezone(user.slack_user_id, ianaTz);
        timezones.push(ianaTz);
        console.log(
          `[calendarScheduler] Cached timezone for ${user.slack_user_id}: ` +
          `"${windowsTz}" → "${ianaTz}"`
        );
      } else {
        console.warn(
          `[calendarScheduler] Unknown M365 timezone "${windowsTz}" for ${user.slack_user_id} — ` +
          'falling back to org timezone for this user.'
        );
      }
    } catch (err) {
      console.warn(
        `[calendarScheduler] mailboxSettings fetch failed for ${user.slack_user_id}:`, err.message
      );
    }
  }

  return timezones;
}

// ── Timezone intersection ─────────────────────────────────────────────────────

/**
 * Given an array of IANA timezone strings, returns the UTC hour bounds that
 * represent the shared business hours and prime hours across all participants.
 *
 * Example — one person in ET, one in CT (summer):
 *   workdayStartHour = 14  (10 AM ET = 9 AM CT in UTC)
 *   workdayEndHour   = 21  ( 5 PM ET = 4 PM CT in UTC)
 *   primeStartHour   = 16  (12 PM ET = 11 AM CT in UTC)
 *   primeEndHour     = 19  ( 3 PM ET = 2 PM CT in UTC)
 *
 * The returned object is meant to be spread into findSlotsWithPrimePreference's
 * options argument together with timezoneId: 'UTC'.
 *
 * Returns null when:
 *   - the array is empty (caller falls back to org timezone)
 *   - no working-hours overlap exists (should never happen for US zones)
 *
 * @param  {string[]} timezones     IANA timezone IDs (e.g. ['America/New_York', 'America/Chicago'])
 * @param  {Date}     referenceDate A date within the target week (used to resolve DST offsets)
 * @returns {{ workdayStartHour, workdayEndHour, primeStartHour, primeEndHour, timezoneId } | null}
 */
function computeIntersection(timezones, referenceDate) {
  if (!timezones || timezones.length === 0) return null;

  // Convert a local hour to a normalized UTC decimal hour on the reference date.
  // We measure ms elapsed since the start of the reference day in UTC, then convert
  // to hours. This handles wrap-around correctly: western timezones where e.g.
  // 5 PM PDT is 00:00 UTC the next day get a normalized value of 24 (not 0),
  // so comparisons like max/min remain meaningful.
  const refDayStartMs = Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  );

  function toUtcHour(localHour, tz) {
    const utcDate = setLocalHour(referenceDate, localHour, 0, tz);
    return (utcDate.getTime() - refDayStartMs) / 3600000;
  }

  const workdayStarts = timezones.map((tz) => toUtcHour(9,  tz));
  const workdayEnds   = timezones.map((tz) => toUtcHour(17, tz));
  const primeStarts   = timezones.map((tz) => toUtcHour(11, tz));
  const primeEnds     = timezones.map((tz) => toUtcHour(15, tz));

  const workdayStartHour = Math.max(...workdayStarts);
  const workdayEndHour   = Math.min(...workdayEnds);

  if (workdayStartHour >= workdayEndHour) {
    console.warn('[calendarScheduler] No working-hours overlap — falling back to org timezone.');
    return null;
  }

  const primeStartHour = Math.max(...primeStarts);
  const primeEndHour   = Math.min(...primeEnds);

  return {
    workdayStartHour,
    workdayEndHour,
    // If prime windows don't overlap, widen prime to the full shared workday
    primeStartHour: primeStartHour < primeEndHour ? primeStartHour : workdayStartHour,
    primeEndHour:   primeStartHour < primeEndHour ? primeEndHour   : workdayEndHour,
    timezoneId:     'UTC',  // all hours are UTC; slot checks must run in UTC
  };
}

// ── Search window ─────────────────────────────────────────────────────────────

/**
 * Builds a search window of 5 business days starting from tomorrow.
 * Weekends are skipped so the window always spans Mon–Fri days only.
 *
 * Start and end are set to 9 AM and 5 PM **in the given timezone** so that
 * slots are only offered during actual business hours (not 5 AM ET / 9 AM UTC).
 *
 * @param  {Date}   fromDate      Reference point (usually `new Date()`)
 * @param  {number} businessDays  Number of business days to cover (default 5)
 * @param  {string} timezoneId    IANA timezone (default 'UTC')
 * @returns {{ start: Date, end: Date }}
 */
function buildSearchWindow(fromDate, businessDays = 5, timezoneId = 'UTC') {
  const startDay = nextBusinessDay(fromDate);
  const start    = setLocalHour(startDay, 9, 0, timezoneId);

  const endDay = addBusinessDays(new Date(startDay), businessDays);
  const end    = setLocalHour(endDay, 17, 0, timezoneId);

  return { start, end };
}

// ── Timezone helpers ──────────────────────────────────────────────────────────

/**
 * Returns the UTC Date that corresponds to `hour:minute` on the same calendar
 * date as `date`, interpreted in `timezoneId`.
 *
 * Example: setLocalHour(someMonday, 9, 0, 'America/New_York')
 *          → returns 13:00 UTC in summer (EDT = UTC-4)
 */
function setLocalHour(date, hour, minute, timezoneId) {
  // Get the local calendar date (YYYY-MM-DD) in the target timezone
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezoneId,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date); // "2026-05-25"

  // Build a naive UTC instant treating that local time as if it were UTC
  const naiveUtc = new Date(
    `${localDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`
  );

  // Compute the actual TZ offset at that moment and shift accordingly
  const offsetMs = getTimezoneOffsetMs(naiveUtc, timezoneId);
  return new Date(naiveUtc.getTime() + offsetMs);
}

/**
 * Returns how many milliseconds UTC is ahead of local time for `timezoneId`
 * at the given `date`. Positive for UTC-X zones (e.g. EDT = +14 400 000 ms).
 */
function getTimezoneOffsetMs(date, timezoneId) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:  timezoneId,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);

  const p = Object.fromEntries(
    parts.filter((x) => x.type !== 'literal').map((x) => [x.type, parseInt(x.value, 10)])
  );
  const localAsUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return date.getTime() - localAsUtcMs;
}

/**
 * Returns a new Date with the UTC hour set to `hour` on the same UTC calendar
 * date as `date`. Used when intersection hours are already in UTC.
 * US timezone offsets are always whole hours, so `hour` is always an integer.
 */
function setUtcHour(date, hour) {
  const d = new Date(date);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

/**
 * Near window: from +2 to +4 business days from `fromDate`.
 * For a Monday match this is Wednesday–Friday of the same week.
 *
 * Without intersection: start = 9 AM local, end = 5 PM local (org timezone).
 * With intersection:    start/end use the shared UTC hours from computeIntersection.
 *
 * @param  {Date}        fromDate      Reference point (usually `new Date()`)
 * @param  {string}      timezoneId    IANA org timezone (fallback when no intersection)
 * @param  {object|null} intersection  Output of computeIntersection(), or null
 * @returns {{ start: Date, end: Date }}
 */
function buildNearWindow(fromDate, timezoneId = 'UTC', intersection = null) {
  const startDay = addBusinessDays(new Date(fromDate), 2);
  const endDay   = addBusinessDays(new Date(fromDate), 4);
  if (intersection) {
    return {
      start: setUtcHour(startDay, intersection.workdayStartHour),
      end:   setUtcHour(endDay,   intersection.workdayEndHour),
    };
  }
  return {
    start: setLocalHour(startDay, 9,  0, timezoneId),
    end:   setLocalHour(endDay,   17, 0, timezoneId),
  };
}

/**
 * Far window: from +5 to +9 business days from `fromDate`.
 * For a Monday match this is the following Monday–Friday.
 *
 * Without intersection: start = 9 AM local, end = 5 PM local (org timezone).
 * With intersection:    start/end use the shared UTC hours from computeIntersection.
 *
 * @param  {Date}        fromDate      Reference point (usually `new Date()`)
 * @param  {string}      timezoneId    IANA org timezone (fallback when no intersection)
 * @param  {object|null} intersection  Output of computeIntersection(), or null
 * @returns {{ start: Date, end: Date }}
 */
function buildFarWindow(fromDate, timezoneId = 'UTC', intersection = null) {
  const startDay = addBusinessDays(new Date(fromDate), 5);
  const endDay   = addBusinessDays(new Date(fromDate), 9);
  if (intersection) {
    return {
      start: setUtcHour(startDay, intersection.workdayStartHour),
      end:   setUtcHour(endDay,   intersection.workdayEndHour),
    };
  }
  return {
    start: setLocalHour(startDay, 9,  0, timezoneId),
    end:   setLocalHour(endDay,   17, 0, timezoneId),
  };
}

function nextBusinessDay(date) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + 1);
  // Skip weekends
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

function addBusinessDays(date, n) {
  const d = new Date(date);
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) added++;
  }
  return d;
}

// ── Slack Block Kit message builder ──────────────────────────────────────────

/**
 * Builds a Block Kit blocks array for the suggestions message.
 * Pure function — no side effects, easy to unit test.
 *
 * @param {Array<{start: Date, end: Date}>} slots
 * @param {number} matchId
 * @param {string}  timezoneId  IANA timezone for display (e.g. 'America/New_York')
 * @param {boolean} testMode    When true, adds a test disclaimer to the context block
 * @returns {object[]}  Slack blocks array
 */
function buildSuggestionsMessage(slots, matchId, timezoneId = 'UTC', testMode = false) {
  const tzAbbr = getTzAbbr(slots[0].start, timezoneId);

  const buttons = slots.map((slot, i) => ({
    type: 'button',
    text: {
      type:  'plain_text',
      text:  formatSlotLabel(slot, timezoneId),
      emoji: false,
    },
    // Value encodes all info needed to book the slot in Step 6:
    //   "<ISO start>|<ISO end>|<matchId>"
    value:     `${slot.start.toISOString()}|${slot.end.toISOString()}|${matchId}`,
    action_id: `watercooler_book_slot_${i}`,
    style:     'primary',
  }));

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '📅 *Here are some times that work for everyone!*\n' +
          'Click a slot to book it — a calendar invite and Teams meeting link will be sent to everyone.',
      },
    },
    {
      type:     'actions',
      elements: buttons,
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_All times in ${tzAbbr}. If none of these work, coordinate directly in this chat._`,
        },
        ...(testMode ? [{
          type: 'mrkdwn',
          text: '_🧪 Test run — please click a slot to help us test the booking flow! No real meeting required._',
        }] : []),
      ],
    },
  ];
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/**
 * Formats a slot as a human-readable button label.
 * Example: "Mon Jun 9, 9:00 – 9:30 AM"
 *
 * Uses Intl.DateTimeFormat (Node built-in) for timezone-aware formatting.
 */
function formatSlotLabel(slot, timezoneId = 'UTC') {
  const startStr = new Intl.DateTimeFormat('en-US', {
    timeZone: timezoneId,
    weekday:  'short',
    month:    'short',
    day:      'numeric',
    hour:     'numeric',
    minute:   '2-digit',
    hour12:   true,
  }).format(slot.start);

  const endStr = new Intl.DateTimeFormat('en-US', {
    timeZone: timezoneId,
    hour:     'numeric',
    minute:   '2-digit',
    hour12:   true,
  }).format(slot.end);

  return `${startStr} – ${endStr}`;
}

/**
 * Returns the short timezone abbreviation for a given date, e.g. "EDT", "CST".
 */
function getTzAbbr(date, timezoneId) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezoneId, timeZoneName: 'short' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value ?? timezoneId;
}

// ── Display timezone helper ───────────────────────────────────────────────────

/**
 * Picks the best timezone to display Slack button labels in.
 *
 * When every participant shares the same timezone (e.g. two Chicago users),
 * their local timezone is used so the times feel natural ("11:00 AM CDT" not
 * "12:00 PM EDT"). When participants span multiple zones, falls back to the
 * org-wide timezone.
 *
 * @param {string[]} timezones  Resolved IANA timezone strings for participants
 * @param {string}   orgTz      Org-wide fallback timezone
 * @returns {string}
 */
function pickDisplayTimezone(timezones, orgTz) {
  if (timezones.length > 0 && timezones.every((tz) => tz === timezones[0])) {
    return timezones[0];
  }
  return orgTz;
}

module.exports = {
  suggestMeetingTimes,
  buildSearchWindow,
  buildNearWindow,
  buildFarWindow,
  buildSuggestionsMessage,
  formatSlotLabel,
  // Exported for testing
  nextBusinessDay,
  addBusinessDays,
  resolveTimezones,
  computeIntersection,
  pickDisplayTimezone,
  WINDOWS_TO_IANA,
};
