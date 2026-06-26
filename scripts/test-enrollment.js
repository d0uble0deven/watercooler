'use strict';

// Channel-based auto-enrollment tests
//
// Covers:
//   • buildWelcomeBlocks      — welcome DM copy
//   • enrollUser              — all status paths (excluded/bot/guest/new/active/returning)
//   • unenrollUser            — opt-out + idempotency
//   • shouldHandle            — event guard (mode / channel / bot self)
//   • channel event handlers  — join enrolls, leave unenrolls, off-mode ignored
//   • sync-channel            — guards, pagination, tally, drift report
//
// Test users are namespaced 'U_TENR_*' and cleaned up before and after.
// Settings (enrollment_mode, intro_channel_id) are saved and restored so the
// dev database is left exactly as it was found.
//
// Run: npm run test:enrollment

const { initDb } = require('../src/db/init');
initDb();

const { enrollUser, unenrollUser, buildWelcomeBlocks } = require('../src/lib/enrollment');
const {
  handleMemberJoinedChannel,
  handleMemberLeftChannel,
  shouldHandle,
} = require('../src/commands/events/channelMembership');
const { syncChannel } = require('../src/commands/admin/sync-channel');

const {
  getUserBySlackId, createUser, updateUser, addExclusion, removeExclusion,
} = require('../src/lib/users');
const { getSettings, updateSettings } = require('../src/lib/rounds');
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

// ── Test fixtures ─────────────────────────────────────────────────────────────

function cleanup() {
  getDb().exec("DELETE FROM users WHERE slack_user_id LIKE 'U_TENR_%'");
  getDb().exec("DELETE FROM exclusions WHERE slack_user_id LIKE 'U_TENR_%'");
}

// Mock Slack client. `profiles` maps userId → partial users.info user object.
function makeClient(profiles, dmLog, memberPages) {
  let pageIdx = 0;
  return {
    users: {
      info: async ({ user }) => ({
        user: { id: user, name: user, profile: { real_name: `Test ${user}` }, ...(profiles[user] || {}) },
      }),
    },
    conversations: {
      open: async () => ({ channel: { id: 'D_' + Math.random().toString(36).slice(2, 8) } }),
      // Returns pages in sequence; fetchAllMembers stops on empty next_cursor.
      members: async () => memberPages ? (memberPages[pageIdx++] || { members: [] }) : { members: [] },
    },
    chat: { postMessage: async (m) => dmLog.push(m.channel) },
  };
}

console.log('\n=== Enrollment Tests ===\n');

// Save settings to restore at the end
const original = getSettings();
const ORIG_MODE    = original.enrollment_mode;
const ORIG_CHANNEL = original.intro_channel_id;

(async () => {
  cleanup();

  // ── buildWelcomeBlocks ──────────────────────────────────────────────────────
  console.log('buildWelcomeBlocks');
  {
    const blocks = buildWelcomeBlocks();
    const text = blocks[0]?.text?.text ?? '';
    check('returns a non-empty blocks array', Array.isArray(blocks) && blocks.length > 0);
    check('mentions Welcome to Watercooler',  text.includes('Welcome to Watercooler'));
    check('explains how to opt out (leave the channel)', text.includes('leave the channel'));
    check('mentions /watercooler pause',      text.includes('/watercooler pause'));
  }

  // ── enrollUser status paths ─────────────────────────────────────────────────
  console.log('\nenrollUser');
  {
    const dm = [];
    const profiles = {
      U_TENR_bot:   { is_bot: true },
      U_TENR_guest: { is_restricted: true },
    };
    const client = makeClient(profiles, dm);

    // excluded wins over everything
    addExclusion('U_TENR_excl', 'test', 'U_ADMIN');
    let s = await enrollUser(client, 'U_TENR_excl', 'channel');
    check('excluded → skipped_excluded', s === 'skipped_excluded', s);
    check('excluded not added to DB',    !getUserBySlackId('U_TENR_excl'));
    removeExclusion('U_TENR_excl');

    // bot
    s = await enrollUser(client, 'U_TENR_bot', 'channel');
    check('bot → skipped_bot',           s === 'skipped_bot', s);
    check('bot not added to DB',          !getUserBySlackId('U_TENR_bot'));

    // guest
    s = await enrollUser(client, 'U_TENR_guest', 'channel');
    check('guest → skipped_guest',       s === 'skipped_guest', s);

    // new normal user
    const before = dm.length;
    s = await enrollUser(client, 'U_TENR_new', 'channel');
    check('new user → enrolled',         s === 'enrolled', s);
    check('new user is active',          getUserBySlackId('U_TENR_new')?.is_active === 1);
    check('enrolled_via = channel',      getUserBySlackId('U_TENR_new')?.enrolled_via === 'channel');
    check('welcome DM sent',             dm.length === before + 1);

    // already active → no-op, no DM
    const before2 = dm.length;
    s = await enrollUser(client, 'U_TENR_new', 'channel');
    check('already active → already_active', s === 'already_active', s);
    check('no extra DM for already-active',  dm.length === before2);

    // returning (deactivated) user → reactivated + DM
    updateUser('U_TENR_new', { is_active: 0 });
    const before3 = dm.length;
    s = await enrollUser(client, 'U_TENR_new', 'sync');
    check('returning user → reactivated', s === 'reactivated', s);
    check('reactivated user is active',   getUserBySlackId('U_TENR_new')?.is_active === 1);
    check('reactivation sent a DM',       dm.length === before3 + 1);
  }

  // ── unenrollUser ────────────────────────────────────────────────────────────
  console.log('\nunenrollUser');
  {
    check('active user → unenrolled', unenrollUser('U_TENR_new') === 'unenrolled');
    check('now inactive',             getUserBySlackId('U_TENR_new')?.is_active === 0);
    check('already inactive → not_enrolled', unenrollUser('U_TENR_new') === 'not_enrolled');
    check('unknown user → not_enrolled (no crash)', unenrollUser('U_TENR_ghost') === 'not_enrolled');
  }

  // ── shouldHandle guard ──────────────────────────────────────────────────────
  console.log('\nshouldHandle (event guard)');
  {
    updateSettings({ enrollment_mode: 'channel', intro_channel_id: 'C_COFFEE' });
    const ctx = { botUserId: 'U_BOT' };
    check('channel mode + right channel + user → true',
      shouldHandle({ channel: 'C_COFFEE', user: 'U_TENR_x' }, ctx) === true);
    check('wrong channel → false',
      shouldHandle({ channel: 'C_OTHER', user: 'U_TENR_x' }, ctx) === false);
    check('bot itself → false',
      shouldHandle({ channel: 'C_COFFEE', user: 'U_BOT' }, ctx) === false);

    updateSettings({ enrollment_mode: 'manual' });
    check('manual mode → false',
      shouldHandle({ channel: 'C_COFFEE', user: 'U_TENR_x' }, ctx) === false);
  }

  // ── Channel event handlers ──────────────────────────────────────────────────
  console.log('\nchannel event handlers');
  {
    const dm = [];
    const client = makeClient({}, dm);
    const ctx = { botUserId: 'U_BOT' };

    // manual mode: join ignored
    updateSettings({ enrollment_mode: 'manual', intro_channel_id: 'C_COFFEE' });
    await handleMemberJoinedChannel({ event: { channel: 'C_COFFEE', user: 'U_TENR_h1' }, client, context: ctx });
    check('manual mode: join ignored', !getUserBySlackId('U_TENR_h1'));

    // channel mode: join enrolls
    updateSettings({ enrollment_mode: 'channel' });
    await handleMemberJoinedChannel({ event: { channel: 'C_COFFEE', user: 'U_TENR_h1' }, client, context: ctx });
    check('channel mode: join enrolls', getUserBySlackId('U_TENR_h1')?.is_active === 1);

    // wrong channel: ignored
    await handleMemberJoinedChannel({ event: { channel: 'C_OTHER', user: 'U_TENR_h2' }, client, context: ctx });
    check('wrong channel: ignored', !getUserBySlackId('U_TENR_h2'));

    // leave: unenrolls
    await handleMemberLeftChannel({ event: { channel: 'C_COFFEE', user: 'U_TENR_h1' }, context: ctx });
    check('channel mode: leave unenrolls', getUserBySlackId('U_TENR_h1')?.is_active === 0);
  }

  // ── sync-channel ────────────────────────────────────────────────────────────
  console.log('\nsync-channel');
  {
    // Guard: manual mode
    updateSettings({ enrollment_mode: 'manual', intro_channel_id: 'C_COFFEE' });
    let m = [];
    await syncChannel({ user_id: 'U_ADMIN' }, async (x) => m.push(x), makeClient({}, []));
    check('guard: manual mode blocks', m[0].includes('Channel enrollment is off'));

    // Guard: no intro channel
    updateSettings({ enrollment_mode: 'channel', intro_channel_id: null });
    m = [];
    await syncChannel({ user_id: 'U_ADMIN' }, async (x) => m.push(x), makeClient({}, []));
    check('guard: no intro channel blocks', m[0].includes('No intro channel'));

    // Happy path with pagination + mixed roster + drift
    updateSettings({ enrollment_mode: 'channel', intro_channel_id: 'C_COFFEE' });
    createUser('U_TENR_drift', 'Drift Person'); // active, NOT in channel
    addExclusion('U_TENR_sx', 'test', 'U_ADMIN');

    const dm = [];
    const profiles = {
      U_TENR_sbot: { is_bot: true },
      U_TENR_sx:   { profile: { real_name: 'Excluded Sync' } },
    };
    const pages = [
      { members: ['U_TENR_s1', 'U_TENR_s2'], response_metadata: { next_cursor: 'P2' } },
      { members: ['U_TENR_sbot', 'U_TENR_sx'], response_metadata: { next_cursor: '' } },
    ];
    const client = makeClient(profiles, dm, pages);

    m = [];
    await syncChannel({ user_id: 'U_ADMIN' }, async (x) => m.push(x), client);
    const summary = m[m.length - 1];

    check('summary: 2 enrolled',          summary.includes('2 enrolled'));
    check('summary: 1 bot skipped',       summary.includes('1 bot'));
    check('summary: 1 excluded skipped',  summary.includes('1 excluded'));
    check('paginated members all seen',   getUserBySlackId('U_TENR_s1') && getUserBySlackId('U_TENR_s2'));
    check('DMs only to the 2 new users',  dm.length === 2, dm.length);
    check('drift report lists Drift Person', summary.includes('Drift Person'));

    removeExclusion('U_TENR_sx');
  }

  // ── Restore + results ───────────────────────────────────────────────────────
  cleanup();
  updateSettings({ enrollment_mode: ORIG_MODE, intro_channel_id: ORIG_CHANNEL });

  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));

  if (failed > 0) process.exit(1);
})();
