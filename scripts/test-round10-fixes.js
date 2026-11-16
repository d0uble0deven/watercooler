'use strict';

// Round 10 (Sep 2026) regression tests
//
// Round 10 posted time suggestions for only 4 of 17 matches. Three causes:
//
//   1. Two company-wide, multi-day invites that most people hadn't answered
//      showed as "tentative" for 8 and 5 straight days — covering the whole
//      slot search window. Tentative counted as busy, so no slots were found.
//      Fix: calendarReader drops tentative blocks of 23h or longer.
//
//   2. When no slots were found, suggestMeetingTimes returned silently — pairs
//      saw the intro and then nothing for ~39 hours.
//      Fix: post a no-slots notice (privately in reschedule mode).
//
//   3. The booking-deadline query compared "YYYY-MM-DD HH:MM:SS" against an
//      ISO string as raw text. The space sorts before "T", so matches became
//      due at 00:00 UTC — midnight Eastern, 39h in instead of 52h.
//      The completion checker's Track B had the same bug.
//      Fix: normalise both sides with SQLite datetime().
//
// Run: npm run test:round10-fixes

const { initDb } = require('../src/db/init');
initDb();

// ── Force the no-slots path inside calendarScheduler ────────────────────────
// calendarScheduler destructures these at require time, so patch → require →
// restore. The scheduler keeps the stubs; the rest of this file gets the
// real slotFinder back for the fix-1 end-to-end check.
const msGraph    = require('../src/integrations/msGraph');
const slotFinder = require('../src/lib/slotFinder');
const calendarReader = require('../src/integrations/calendarReader');

const realGetGraphClient = msGraph.getGraphClient;
const realFindPrime      = slotFinder.findSlotsWithPrimePreference;
const realFindSlots      = slotFinder.findSlots;
const realGetFreeBusy    = calendarReader.getFreeBusy;
msGraph.getGraphClient                = () => ({});
slotFinder.findSlotsWithPrimePreference = () => [];
slotFinder.findSlots                  = () => [];   // the private full list's finder
calendarReader.getFreeBusy            = async () => [];

const { suggestMeetingTimes, buildNoSlotsNotice } = require('../src/integrations/calendarScheduler');

msGraph.getGraphClient                  = realGetGraphClient;
slotFinder.findSlotsWithPrimePreference = realFindPrime;
slotFinder.findSlots                    = realFindSlots;
calendarReader.getFreeBusy              = realGetFreeBusy;

const { parseResponse } = calendarReader;
const { getMatchesDueForCompletion } = require('../src/integrations/meetingCompleter');
const {
  createRound, saveMatch, saveMatchMembers, completeRound, updateMatchChannel,
  getMatch, getUnbookedMatchesPastDeadline,
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
             WHERE r.created_by = 'test-round10')`);
  db.exec(`DELETE FROM matches WHERE round_id IN (SELECT id FROM rounds WHERE created_by = 'test-round10')`);
  db.exec(`DELETE FROM rounds WHERE created_by = 'test-round10'`);
  db.exec(`DELETE FROM users WHERE slack_user_id LIKE 'U_R10_%'`);
}

/** Completed round + unbooked 2-person match with a DM channel. */
function makeMatch(tag, completedAt) {
  const roundId = createRound('test-round10');
  const matchId = saveMatch(roundId);
  const a = createUser(`U_R10_${tag}_A`, `R10 ${tag} A`);
  const b = createUser(`U_R10_${tag}_B`, `R10 ${tag} B`);
  saveUserEmail(`U_R10_${tag}_A`, `${tag.toLowerCase()}-a@example.test`);
  saveUserEmail(`U_R10_${tag}_B`, `${tag.toLowerCase()}-b@example.test`);
  saveMatchMembers(matchId, [a.id, b.id]);
  updateMatchChannel(matchId, `C_R10_${tag}`);
  completeRound(roundId);
  getDb().prepare('UPDATE rounds SET completed_at = ? WHERE id = ?').run(completedAt, roundId);
  return matchId;
}

/** Graph getSchedule item, times as Graph returns them (UTC, no Z). */
function item(start, end, status) {
  return { start: { dateTime: start, timeZone: 'UTC' }, end: { dateTime: end, timeZone: 'UTC' }, status };
}

/** "YYYY-MM-DD HH:MM:SS" — the format SQLite's datetime('now') writes. */
function sqliteTs(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

console.log('\n=== Round 10 Regression Tests ===\n');

(async () => {
  cleanup();

  // ── Fix 1: all-day / multi-day tentative blocks ────────────────────────────
  console.log('fix 1 — parseResponse drops all-day+ tentative blocks');
  {
    const statuses = (items) =>
      parseResponse({ value: [{ scheduleId: 'x@example.test', scheduleItems: items }] })[0].busySlots;

    check('8-day tentative (Sep 11→19 company invite) dropped',
      statuses([item('2026-09-11T04:00:00', '2026-09-19T04:00:00', 'tentative')]).length === 0);
    check('5-day tentative (Sep 21→26 company invite) dropped',
      statuses([item('2026-09-21T04:00:00', '2026-09-26T04:00:00', 'tentative')]).length === 0);
    check('single all-day tentative (24h) dropped',
      statuses([item('2026-09-16T04:00:00', '2026-09-17T04:00:00', 'tentative')]).length === 0);
    check('all-day tentative on spring-forward DST day (23h) dropped',
      statuses([item('2026-03-08T05:00:00', '2026-03-09T04:00:00', 'tentative')]).length === 0);

    const kept5h = statuses([item('2026-09-22T16:00:00', '2026-09-22T21:00:00', 'tentative')]);
    check('5-hour tentative block still blocks', kept5h.length === 1, kept5h.length);
    const kept1h = statuses([item('2026-09-17T14:30:00', '2026-09-17T15:30:00', 'tentative')]);
    check('1-hour tentative meeting still blocks', kept1h.length === 1, kept1h.length);

    check('multi-day busy still blocks',
      statuses([item('2026-09-11T04:00:00', '2026-09-19T04:00:00', 'busy')]).length === 1);
    check('multi-day out-of-office still blocks (real absence)',
      statuses([item('2026-09-14T04:00:00', '2026-09-26T04:00:00', 'oof')]).length === 1);
    check('free / workingElsewhere still ignored',
      statuses([
        item('2026-09-16T13:00:00', '2026-09-16T14:00:00', 'free'),
        item('2026-09-16T15:00:00', '2026-09-16T16:00:00', 'workingElsewhere'),
      ]).length === 0);
  }

  console.log('\nfix 1 — end-to-end: the Francis & Steve calendars now yield slots');
  {
    // Shape of what Graph returned for match 66 (times only, abridged):
    // both people carried the two long tentative invites plus normal meetings.
    const invites = [
      item('2026-09-11T04:00:00', '2026-09-19T04:00:00', 'tentative'),
      item('2026-09-21T04:00:00', '2026-09-26T04:00:00', 'tentative'),
    ];
    const response = { value: [
      { scheduleId: 'francis@example.test', scheduleItems: [
        ...invites,
        item('2026-09-16T15:30:00', '2026-09-16T16:30:00', 'busy'),
        item('2026-09-16T19:00:00', '2026-09-16T20:00:00', 'busy'),
        item('2026-09-17T14:30:00', '2026-09-17T15:30:00', 'tentative'),
      ] },
      { scheduleId: 'steve@example.test', scheduleItems: [
        ...invites,
        item('2026-09-16T14:15:00', '2026-09-16T15:15:00', 'busy'),
        item('2026-09-17T19:30:00', '2026-09-17T21:30:00', 'busy'),
      ] },
    ] };

    // Round 10's near window: Wed Sep 16 9 AM → Fri Sep 18 5 PM Eastern.
    const nearStart = new Date('2026-09-16T13:00:00Z');
    const nearEnd   = new Date('2026-09-18T21:00:00Z');
    const busyData  = parseResponse(response);
    const slots = slotFinder.findSlotsWithPrimePreference(
      busyData, nearStart, nearEnd, 15, 2, 'America/New_York', 120);
    check('near window now offers 2 slots (was 0)', slots.length === 2, slots.length);
    check('offered slots avoid the real meetings',
      slots.every((s) => busyData.every((p) => p.busySlots.every((b) => s.end <= b.start || s.start >= b.end))));
  }

  // ── Fix 2: no-slots notice instead of silence ──────────────────────────────
  console.log('\nfix 2 — buildNoSlotsNotice copy');
  {
    const pub  = buildNoSlotsNotice(2)[0].text.text;
    check('public: says "both" for a pair', pub.includes("you're both free"), pub);
    check('public: points to /watercooler reschedule', pub.includes('/watercooler reschedule'));
    check('public: no test disclaimer by default', buildNoSlotsNotice(2).length === 1);

    const trio = buildNoSlotsNotice(3)[0].text.text;
    check('group of 3: says "all"', trio.includes("you're all free"), trio);

    const priv = buildNoSlotsNotice(2, { isPrivate: true })[0].text.text;
    check('private: reassures the match was not notified', priv.includes("hasn't been notified"), priv);
    check('private: does not tell them to run reschedule (they just did)',
      !priv.includes('/watercooler reschedule'));

    const test = buildNoSlotsNotice(2, { testMode: true });
    check('test mode: adds 🧪 disclaimer', test.length === 2 && test[1].elements[0].text.includes('🧪'));
    check('notice has no buttons', buildNoSlotsNotice(2).every((b) => b.type !== 'actions'));
  }

  console.log('\nfix 2 — suggestMeetingTimes posts the notice when no slots exist');
  {
    const matchId = makeMatch('NOTICE', sqliteTs(new Date()));
    const users = [
      { slack_user_id: 'U_R10_NOTICE_A', display_name: 'A', slack_email: 'a@example.test', ms_timezone: 'America/New_York' },
      { slack_user_id: 'U_R10_NOTICE_B', display_name: 'B', slack_email: 'b@example.test', ms_timezone: 'America/New_York' },
    ];
    const posts = [];
    const ephemerals = [];
    const client = {
      chat: {
        postMessage:   async (m) => { posts.push(m); return { ts: '999.1' }; },
        postEphemeral: async (m) => { ephemerals.push(m); return {}; },
      },
    };
    const settings = { calendar_enabled: 1, meeting_duration: 15, calendar_timezone: 'America/New_York' };

    await suggestMeetingTimes(client, 'C_R10_NOTICE', matchId, users, settings);
    check('round start: exactly one public message', posts.length === 1 && ephemerals.length === 0,
      { posts: posts.length, ephemerals: ephemerals.length });
    check('round start: it is the no-slots notice', posts[0]?.text.includes("couldn't find"), posts[0]?.text);
    check('round start: posted to the match DM', posts[0]?.channel === 'C_R10_NOTICE');
    check('round start: suggestion ts NOT saved (no buttons to update)',
      getMatch(matchId).calendar_suggestion_ts === null, getMatch(matchId).calendar_suggestion_ts);

    posts.length = 0;
    await suggestMeetingTimes(client, 'C_R10_NOTICE', matchId, users, settings, false,
      { browse: true, privateToUserId: 'U_R10_NOTICE_A' });
    check('reschedule: nothing posted publicly (partner not notified)', posts.length === 0, posts.length);
    check('reschedule: notice sent privately to the requester only',
      ephemerals.length === 1 && ephemerals[0].user === 'U_R10_NOTICE_A', ephemerals.map((e) => e.user));
    check('reschedule: private copy used', ephemerals[0]?.blocks[0].text.text.includes("hasn't been notified"));

    const failing = { chat: { postMessage: async () => { throw new Error('channel_not_found'); } } };
    let threw = false;
    try { await suggestMeetingTimes(failing, 'C_R10_NOTICE', matchId, users, settings); }
    catch { threw = true; }
    check('a failed Slack post is logged, never thrown', !threw);
  }

  // ── Fix 3: deadline + completion timing ────────────────────────────────────
  console.log('\nfix 3 — booking deadline fires at 52h, not at midnight');
  {
    // Exactly round 10: completed 2026-09-14 13:00:35 UTC, 52h deadline.
    const matchId  = makeMatch('DEADLINE', '2026-09-14 13:00:35');
    const due = (nowIso) => getUnbookedMatchesPastDeadline(52, new Date(nowIso)).some((m) => m.id === matchId);

    check('39h in (Sep 16 04:00 UTC — when prod fired) → NOT due', !due('2026-09-16T04:00:10Z'));
    check('51h58m in → not due yet', !due('2026-09-16T16:58:35Z'));
    check('52h01m in → due', due('2026-09-16T17:01:35Z'));

    // Guard against rows written in ISO format too (normalisation handles both).
    getDb().prepare(`UPDATE rounds SET completed_at = '2026-09-14T13:00:35.000Z'
                     WHERE id = (SELECT round_id FROM matches WHERE id = ?)`).run(matchId);
    check('ISO-format completed_at: 39h → not due', !due('2026-09-16T04:00:10Z'));
    check('ISO-format completed_at: 52h01m → due', due('2026-09-16T17:01:35Z'));
  }

  console.log('\nfix 3 — completion Track B fires after the fallback window, not early');
  {
    const now    = new Date('2026-09-30T12:00:00Z');
    // Track B cutoff is 12 business days back from `now`, same time of day.
    const { subtractBusinessDays } = require('../src/integrations/meetingCompleter');
    const cutoff = subtractBusinessDays(now, 12);

    const later   = makeMatch('TRACKB_LATE',  sqliteTs(new Date(cutoff.getTime() + 60 * 60 * 1000)));
    const earlier = makeMatch('TRACKB_EARLY', sqliteTs(new Date(cutoff.getTime() - 60 * 60 * 1000)));
    const dueIds  = getMatchesDueForCompletion(12, now).map((m) => m.id);

    check('round completed 1h AFTER cutoff (same day) → not due yet', !dueIds.includes(later));
    check('round completed 1h BEFORE cutoff → due', dueIds.includes(earlier));
  }

  cleanup();

  console.log('\n──────────────────────────────────────────');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('──────────────────────────────────────────');
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Test run crashed:', err);
  cleanup();
  process.exit(1);
});
