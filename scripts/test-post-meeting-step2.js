'use strict';

// Phase 11 Step 2 — Completion message builder + query tests
//
// Tests:
//   • subtractBusinessDays()          — skips weekends correctly
//   • calculateNextRoundDate()        — returns correct next weekday for various settings
//   • formatRoundDate()               — returns human-readable date string
//   • buildCompletionMessage()        — correct blocks, button IDs, matchId in values
//   • getMatchesDueForCompletion()    — Track A, Track B, and all exclusion cases
//
// No Azure credentials or Slack tokens required.
// Run: npm run test:post2

process.env.ADMIN_USER_IDS = 'UADMIN0';
process.env.DATABASE_PATH  = './data/test-post2.db';

const fs = require('node:fs');
fs.mkdirSync('./data', { recursive: true });
const dbPath = process.env.DATABASE_PATH;
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const { initDb }    = require('../src/db/init');
const { getDb }     = require('../src/db/connection');
const {
  getMatchesDueForCompletion,
  buildCompletionMessage,
  calculateNextRoundDate,
  subtractBusinessDays,
  formatRoundDate,
} = require('../src/integrations/meetingCompleter');

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

console.log('\n=== Phase 11 — Step 2: Completion Message Builder + Query ===\n');

// ── subtractBusinessDays ──────────────────────────────────────────────────────
console.log('subtractBusinessDays()');
{
  // Friday - 1 business day = Thursday
  const fri = new Date('2026-06-05T12:00:00Z'); // Friday
  const thu = subtractBusinessDays(fri, 1);
  check('Fri - 1 biz day = Thu', thu.getUTCDay() === 4, thu.toISOString());

  // Monday - 1 business day = Friday (skips weekend)
  const mon = new Date('2026-06-08T12:00:00Z'); // Monday
  const prevFri = subtractBusinessDays(mon, 1);
  check('Mon - 1 biz day = Fri (skips weekend)', prevFri.getUTCDay() === 5, prevFri.toISOString());

  // Monday - 5 business days = Monday previous week
  const prevMon = subtractBusinessDays(mon, 5);
  check('Mon - 5 biz days = prev Mon', prevMon.getUTCDay() === 1, prevMon.toISOString());

  // Monday Jun 22 - 12 business days = Thursday Jun 4
  // (Mon→Fri Jun19, Thu Jun18, Wed17, Tue16, Mon15, Fri12, Thu11, Wed10, Tue9, Mon8, Fri5, Thu4)
  const mon2 = new Date('2026-06-22T10:00:00Z'); // Monday Jun 22
  const cutoff = subtractBusinessDays(mon2, 12);
  check('Mon Jun 22 - 12 biz days = Thu Jun 4', cutoff.getUTCDay() === 4, cutoff.toISOString());
}

// ── calculateNextRoundDate ────────────────────────────────────────────────────
console.log('\ncalculateNextRoundDate()');
{
  // Settings: monday at 10:00
  const settings = { intro_day: 'monday', intro_time: '10:00', cadence: 'triweekly' };
  const next = calculateNextRoundDate(settings);
  check('returns a Date',       next instanceof Date);
  check('returned day is Monday', next.getDay() === 1, next.toDateString());
  check('returned time is 10:00', next.getHours() === 10 && next.getMinutes() === 0);
  check('returned date is in the future', next > new Date());

  // Settings: friday at 09:00
  const friSettings = { intro_day: 'friday', intro_time: '09:00', cadence: 'weekly' };
  const nextFri = calculateNextRoundDate(friSettings);
  check('friday setting returns a Friday', nextFri.getDay() === 5, nextFri.toDateString());
}

// ── formatRoundDate ───────────────────────────────────────────────────────────
console.log('\nformatRoundDate()');
{
  const date = new Date('2026-06-16T14:00:00Z'); // Monday Jun 16 at 10 AM ET (UTC-4)
  const label = formatRoundDate(date, 'America/New_York');
  check('returns a string',             typeof label === 'string');
  check('contains weekday name',        label.includes('Monday') || label.includes('Tuesday') || label.includes('Wednesday') || label.includes('Thursday') || label.includes('Friday') || label.includes('Saturday') || label.includes('Sunday'));
  check('contains month abbreviation',  label.includes('Jun'), label);
  check('contains day number',          /\d+/.test(label));
}

// ── buildCompletionMessage ────────────────────────────────────────────────────
console.log('\nbuildCompletionMessage()');
{
  const nextDate = new Date('2026-06-16T14:00:00Z');
  const matchId  = 42;

  // Track A (meeting was booked via Slack)
  const blocksA = buildCompletionMessage(matchId, nextDate, 'America/New_York', true);
  check('returns an array',                         Array.isArray(blocksA));
  check('has at least 5 blocks',                    blocksA.length >= 5, blocksA.length);

  const intro = blocksA[0];
  check('first block is section',                   intro?.type === 'section');
  check('Track A text mentions scheduled time',     intro?.text?.text?.includes('scheduled meeting time'), intro?.text?.text);
  check('includes next round date',                 intro?.text?.text?.includes('Jun'), intro?.text?.text);

  const feedbackSection = blocksA[1];
  check('feedback question block exists',           feedbackSection?.text?.text?.includes('Watercooler intro'), feedbackSection?.text?.text);

  const feedbackActions = blocksA[2];
  check('feedback actions block exists',            feedbackActions?.type === 'actions');
  check('has 2 feedback buttons',                   feedbackActions?.elements?.length === 2, feedbackActions?.elements?.length);

  const goodBtn = feedbackActions?.elements?.[0];
  check('good button action_id correct',            goodBtn?.action_id === 'watercooler_meeting_good', goodBtn?.action_id);
  check('good button value is matchId',             goodBtn?.value === String(matchId), goodBtn?.value);
  check('good button has primary style',            goodBtn?.style === 'primary');

  const mehBtn = feedbackActions?.elements?.[1];
  check('meh button action_id correct',             mehBtn?.action_id === 'watercooler_meeting_meh', mehBtn?.action_id);
  check('meh button value is matchId',              mehBtn?.value === String(matchId), mehBtn?.value);

  const snoozeSection = blocksA[3];
  check('Too Busy section exists',                  snoozeSection?.text?.text?.includes('Too Busy'), snoozeSection?.text?.text);

  const snoozeActions = blocksA[4];
  check('snooze actions block exists',              snoozeActions?.type === 'actions');
  const snoozeBtn = snoozeActions?.elements?.[0];
  check('snooze button action_id correct',          snoozeBtn?.action_id === 'watercooler_meeting_snooze', snoozeBtn?.action_id);
  check('snooze button value is matchId',           snoozeBtn?.value === String(matchId), snoozeBtn?.value);

  // Track B (no Slack booking)
  const blocksB = buildCompletionMessage(matchId, nextDate, 'America/New_York', false);
  const introB  = blocksB[0];
  check('Track B text mentions matching window',    introB?.text?.text?.includes('matching window'), introB?.text?.text);
}

// ── getMatchesDueForCompletion ────────────────────────────────────────────────
console.log('\ngetMatchesDueForCompletion() — DB query');

initDb();
{
  const db = getDb();

  // Helper: insert a completed round with a given completed_at
  function insertRound(completedAt) {
    db.prepare(`INSERT INTO rounds (status, started_at, completed_at, created_by) VALUES ('completed', ?, ?, 'test')`)
      .run(completedAt, completedAt);
    return db.prepare(`SELECT last_insert_rowid() AS id`).get().id;
  }

  // Helper: insert a match
  // Use 'key' in opts instead of ?? so that an explicit null channelId is stored as NULL
  function insertMatch(roundId, opts = {}) {
    const channelId = 'channelId' in opts ? opts.channelId : 'C_TEST';
    db.prepare(`
      INSERT INTO matches (round_id, slack_dm_channel_id, meeting_end_at, completion_message_sent)
      VALUES (?, ?, ?, ?)
    `).run(roundId, channelId, opts.meetingEndAt ?? null, opts.sent ?? 0);
    return db.prepare(`SELECT last_insert_rowid() AS id`).get().id;
  }

  const longAgo   = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(); // 20 days ago
  const recentish = new Date(Date.now() -  1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
  const future    = new Date(Date.now() +  2 * 60 * 60 * 1000).toISOString();       // 2 hours from now
  const past      = new Date(Date.now() -  2 * 60 * 60 * 1000).toISOString();       // 2 hours ago

  // Round A: completed long ago (> 12 biz days)
  const oldRoundId = insertRound(longAgo);

  // Round B: completed 1 day ago (< 12 biz days)
  const recentRoundId = insertRound(recentish);

  // Match 1: Track A — meeting_end_at in the past → SHOULD be returned
  const m1 = insertMatch(oldRoundId, { meetingEndAt: past });

  // Match 2: Track A — meeting_end_at in the future → should NOT
  const m2 = insertMatch(oldRoundId, { meetingEndAt: future });

  // Match 3: Track B — old round, no meeting_end_at → SHOULD be returned
  const m3 = insertMatch(oldRoundId);

  // Match 4: Track B — recent round, no meeting_end_at → should NOT (within fallback window)
  const m4 = insertMatch(recentRoundId);

  // Match 5: already sent → should NOT
  const m5 = insertMatch(oldRoundId, { sent: 1 });

  // Match 6: no DM channel → should NOT
  insertMatch(oldRoundId, { channelId: null });

  const results = getMatchesDueForCompletion(12);
  const ids = results.map(r => r.id);

  check('returns exactly 2 matches',            results.length === 2, results.length);
  check('Track A (past end time) included',     ids.includes(m1), ids);
  check('Track A (future end time) excluded',   !ids.includes(m2));
  check('Track B (old round) included',         ids.includes(m3), ids);
  check('Track B (recent round) excluded',      !ids.includes(m4));
  check('already-sent match excluded',          !ids.includes(m5));

  // Edge case: 0-day fallback returns everything unblocked in old round
  const allResults = getMatchesDueForCompletion(0);
  check('0-day fallback includes Track B recent', allResults.some(r => r.id === m4));
}

// ── Results ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(42)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(42));

try { fs.unlinkSync(dbPath); } catch (_) {}
if (failed > 0) process.exit(1);
