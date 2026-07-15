'use strict';

// Decline watcher tests
//
// Covers:
//   • migration          — matches.decline_notified_at column
//   • getBookedFutureMatches — all the query filters
//   • buildDeclineMessage — copy + reusable reschedule button
//   • runDeclineCheck    — end-to-end with a mocked Graph client:
//       declined → one nudge posted + stamped, never re-posted
//       accepted-only → nothing posted, stays watched
//       404 (event deleted) → retired quietly
//
// Run: npm run test:decline

const { initDb } = require('../src/db/init');
initDb();

// Patch the Graph client factory BEFORE the watcher destructures it.
const msGraph = require('../src/integrations/msGraph');
let graphResponder = null; // set per test; (eventId) => attendees payload or throws
msGraph.getGraphClient = () => ({
  api: (url) => ({
    select: () => ({
      get: async () => graphResponder(url),
    }),
  }),
});

const { runDeclineCheck, buildDeclineMessage } = require('../src/integrations/declineWatcher');

const {
  createRound, saveMatch, saveMatchMembers, completeRound, updateMatchChannel,
  saveBooking, saveMeetingTimes, getMatch,
  getBookedFutureMatches, markDeclineNotified,
  getSettings, updateSettings,
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
             WHERE r.created_by = 'test-decline')`);
  db.exec(`DELETE FROM matches WHERE round_id IN (SELECT id FROM rounds WHERE created_by = 'test-decline')`);
  db.exec(`DELETE FROM rounds WHERE created_by = 'test-decline'`);
  db.exec(`DELETE FROM users WHERE slack_user_id LIKE 'U_DECL_%'`);
}

// Creates a booked match with a future meeting; returns matchId.
function makeBookedMatch(roundId, ids, eventId, startOffsetMs) {
  const matchId = saveMatch(roundId);
  saveMatchMembers(matchId, ids);
  updateMatchChannel(matchId, `C_DECL_${matchId}`);
  saveBooking(matchId, { calendarEventId: eventId, teamsLink: null });
  const start = new Date(Date.now() + startOffsetMs);
  saveMeetingTimes(matchId, start, new Date(start.getTime() + 15 * 60000));
  return matchId;
}

console.log('\n=== Decline Watcher Tests ===\n');

const originalSettings = getSettings();

(async () => {
  cleanup();
  updateSettings({ calendar_enabled: 1 });

  // ── Fixture users ───────────────────────────────────────────────────────────
  const roundId = createRound('test-decline');
  const u1 = createUser('U_DECL_1', 'Dana Decliner');
  const u2 = createUser('U_DECL_2', 'Oscar Organizer');
  saveUserEmail('U_DECL_1', 'dana@example.test');
  saveUserEmail('U_DECL_2', 'oscar@example.test');
  completeRound(roundId);

  // ── Migration ───────────────────────────────────────────────────────────────
  console.log('migration');
  {
    const cols = getDb().prepare('PRAGMA table_info(matches)').all().map((c) => c.name);
    check('matches.decline_notified_at column exists', cols.includes('decline_notified_at'));
  }

  // ── getBookedFutureMatches filters ──────────────────────────────────────────
  console.log('\ngetBookedFutureMatches');
  {
    const future  = makeBookedMatch(roundId, [u2.id, u1.id], 'evt-future', +2 * 86400000);
    const past    = makeBookedMatch(roundId, [u2.id, u1.id], 'evt-past',   -2 * 86400000);
    const unbooked = saveMatch(roundId);
    updateMatchChannel(unbooked, 'C_DECL_UNBOOKED');

    const ids = getBookedFutureMatches().map((m) => m.id);
    check('includes booked future match',      ids.includes(future));
    check('excludes past meeting',             !ids.includes(past));
    check('excludes unbooked match',           !ids.includes(unbooked));

    markDeclineNotified(future);
    check('excludes already-notified match',
      !getBookedFutureMatches().some((m) => m.id === future));

    // pending claim sentinel is not a watchable event
    const pending = saveMatch(roundId);
    updateMatchChannel(pending, 'C_DECL_PENDING');
    getDb().prepare(`UPDATE matches SET calendar_event_id = 'pending', meeting_start_at = ? WHERE id = ?`)
      .run(new Date(Date.now() + 86400000).toISOString(), pending);
    check('excludes pending-claim sentinel',
      !getBookedFutureMatches().some((m) => m.id === pending));
  }

  // ── buildDeclineMessage ─────────────────────────────────────────────────────
  console.log('\nbuildDeclineMessage');
  {
    const blocks = buildDeclineMessage(42, ['Dana Decliner']);
    const text   = blocks[0].text.text;
    check('names the decliner',            text.includes('Dana Decliner'));
    check('asks about picking a new time', text.includes('pick a new one'));

    const btn = blocks.find((b) => b.type === 'actions')?.elements?.[0];
    check('reuses the reschedule action',  btn?.action_id === 'watercooler_reschedule');
    check('button value is the matchId',   btn?.value === '42');

    const two = buildDeclineMessage(7, ['A', 'B'])[0].text.text;
    check('joins multiple decliners',      two.includes('A and B'));
  }

  // ── runDeclineCheck end-to-end ──────────────────────────────────────────────
  console.log('\nrunDeclineCheck — declined attendee');
  {
    const matchId = makeBookedMatch(roundId, [u2.id, u1.id], 'evt-declined', +3 * 86400000);
    graphResponder = () => ({
      attendees: [
        { emailAddress: { address: 'oscar@example.test' }, status: { response: 'organizer' } },
        { emailAddress: { address: 'dana@example.test' },  status: { response: 'declined' } },
      ],
    });

    const posts = [];
    const client = { chat: { postMessage: async (m) => posts.push(m) } };

    await runDeclineCheck(client, getSettings(), { force: true });
    check('posts exactly one nudge',        posts.length === 1, posts.length);
    check('nudge goes to the match DM',     posts[0]?.channel === `C_DECL_${matchId}`);
    check('nudge names Dana',               posts[0]?.text.includes('Dana Decliner'), posts[0]?.text);
    check('match stamped',                  !!getMatch(matchId).decline_notified_at);

    await runDeclineCheck(client, getSettings(), { force: true });
    check('second sweep posts nothing',     posts.length === 1, posts.length);
  }

  console.log('\nrunDeclineCheck — nobody declined');
  {
    const matchId = makeBookedMatch(roundId, [u2.id, u1.id], 'evt-accepted', +3 * 86400000);
    graphResponder = () => ({
      attendees: [
        { emailAddress: { address: 'oscar@example.test' }, status: { response: 'organizer' } },
        { emailAddress: { address: 'dana@example.test' },  status: { response: 'accepted' } },
      ],
    });

    const posts = [];
    await runDeclineCheck({ chat: { postMessage: async (m) => posts.push(m) } }, getSettings(), { force: true });
    check('nothing posted',                 posts.length === 0, posts.length);
    check('match NOT stamped (still watched)', getMatch(matchId).decline_notified_at === null);
    markDeclineNotified(matchId); // retire so later tests don't see it
  }

  console.log('\nrunDeclineCheck — event deleted in Outlook (404)');
  {
    const matchId = makeBookedMatch(roundId, [u2.id, u1.id], 'evt-gone', +3 * 86400000);
    graphResponder = () => { const e = new Error('ErrorItemNotFound'); e.statusCode = 404; throw e; };

    const posts = [];
    await runDeclineCheck({ chat: { postMessage: async (m) => posts.push(m) } }, getSettings(), { force: true });
    check('nothing posted for vanished event', posts.length === 0, posts.length);
    check('match retired from watch',          !!getMatch(matchId).decline_notified_at);
  }

  // ── Restore + results ───────────────────────────────────────────────────────
  cleanup();
  updateSettings({ calendar_enabled: originalSettings.calendar_enabled });

  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));

  if (failed > 0) process.exit(1);
})();
