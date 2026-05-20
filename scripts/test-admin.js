'use strict';

// Phase 7 — Admin Management Commands smoke test
//
// Tests every new admin command without a real Slack connection.
// Run:  npm run test:admin
//
// What it covers:
//   summary         — shows participant counts
//   participants    — lists eligible users
//   paused          — lists paused users
//   settings        — shows current settings
//   recent-rounds   — shows last N rounds
//   set group-size  — updates setting with validation
//   set cadence     — updates setting with validation
//   set avoid-repeat-rounds — updates setting
//   set channel     — updates setting
//   exclude         — adds exclusion (mention + raw ID + missing arg)
//   include         — removes exclusion (valid + not-found)
//   non-admin guard — blocks non-admin users
//   unknown command — shows help text

// ── env must be set BEFORE any require() so config.js picks them up ──────────
// IDs must match Slack's format (uppercase letters + digits, no underscores)
// so parseUserMention() in exclusions.js accepts them.
process.env.ADMIN_USER_IDS  = 'UADMIN0';
process.env.DATABASE_PATH   = './data/test-admin.db';

const fs = require('node:fs');

// Ensure the data dir exists (db init will create the file)
fs.mkdirSync('./data', { recursive: true });

// Wipe any leftover test DB so each run starts clean
const dbPath = process.env.DATABASE_PATH;
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const { initDb }       = require('../src/db/init');
const { handleAdmin }  = require('../src/commands/admin/index');
const { createUser, updateUser } = require('../src/lib/users');

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function makeCommand(userId = 'UADMIN0') {
  return { user_id: userId };
}

async function runCmd(text, userId = 'UADMIN0') {
  let response = null;
  const respond = async (msg) => { response = msg; };
  await handleAdmin(makeCommand(userId), text, respond, null);
  return response;
}

function check(label, condition, actual) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    console.error(`     Got: ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Bootstrap ───────────────────────────────────────────────────────────────
  initDb();

  // Use realistic Slack-format IDs (uppercase letters + digits only)
  // so parseUserMention() regex accepts them in exclude/include tests.
  createUser('UALICE0', 'Alice');
  createUser('UBOB000', 'Bob');
  createUser('UCAROL0', 'Carol');
  createUser('UDAVE00', 'Dave');

  updateUser('UALICE0', { is_active: 1, is_paused: 0 }); // eligible
  updateUser('UBOB000', { is_active: 1, is_paused: 0 }); // eligible
  updateUser('UCAROL0', { is_active: 1, is_paused: 1 }); // paused
  updateUser('UDAVE00', { is_active: 1, is_paused: 0 }); // eligible (excluded via command)

  console.log('\n=== Phase 7 Admin Command Tests ===\n');

  // ── Non-admin guard ─────────────────────────────────────────────────────────
  console.log('Non-admin guard');
  {
    const r = await runCmd('summary', 'USTRNGR');
    check('blocks non-admin', r.includes('⛔'), r);
  }

  // ── Unknown subcommand → help ───────────────────────────────────────────────
  console.log('\nUnknown subcommand');
  {
    const r = await runCmd('foobar');
    check('unknown command shows help', r.includes('Watercooler admin commands'), r);

    const r2 = await runCmd('');
    check('empty text shows help', r2.includes('Watercooler admin commands'), r2);
  }

  // ── summary ─────────────────────────────────────────────────────────────────
  console.log('\nsummary');
  {
    const r = await runCmd('summary');
    check('header present',           r.includes('Watercooler Summary'), r);
    check('shows eligible count',     r.includes('Eligible for next match'), r);
    check('shows completed rounds',   r.includes('Completed rounds'), r);
  }

  // ── participants ────────────────────────────────────────────────────────────
  console.log('\nparticipants');
  {
    const r = await runCmd('participants');
    check('lists Alice',              r.includes('Alice'), r);
    check('lists Bob',                r.includes('Bob'), r);
    check('omits Carol (paused)',     !r.includes('Carol'), r);
  }

  // ── paused ──────────────────────────────────────────────────────────────────
  console.log('\npaused');
  {
    const r = await runCmd('paused');
    check('lists Carol',              r.includes('Carol'), r);
    check('omits Alice (eligible)',   !r.includes('Alice'), r);
  }

  // ── settings ────────────────────────────────────────────────────────────────
  console.log('\nsettings');
  {
    const r = await runCmd('settings');
    check('shows group size',         r.includes('Group size'), r);
    check('shows cadence',            r.includes('Cadence'), r);
    check('shows avoid-repeat-rounds', r.includes('Avoid repeat rounds'), r);
  }

  // ── recent-rounds (no rounds yet) ───────────────────────────────────────────
  console.log('\nrecent-rounds (no rounds)');
  {
    const r = await runCmd('recent-rounds');
    check('no rounds message',        r.includes('No completed rounds'), r);
  }

  // ── set group-size ──────────────────────────────────────────────────────────
  console.log('\nset group-size');
  {
    const ok = await runCmd('set group-size 3');
    check('accepts valid value',      ok.includes('✅') && ok.includes('3'), ok);

    const bad1 = await runCmd('set group-size 1');
    check('rejects n < 2',            bad1.includes('❌'), bad1);

    const bad2 = await runCmd('set group-size banana');
    check('rejects non-number',       bad2.includes('❌'), bad2);

    await runCmd('set group-size 2'); // reset
  }

  // ── set avoid-repeat-rounds ─────────────────────────────────────────────────
  console.log('\nset avoid-repeat-rounds');
  {
    const ok = await runCmd('set avoid-repeat-rounds 4');
    check('accepts 4',                ok.includes('✅') && ok.includes('4'), ok);

    const zero = await runCmd('set avoid-repeat-rounds 0');
    check('accepts 0 with note',      zero.includes('✅') && zero.includes('allowed immediately'), zero);

    const bad = await runCmd('set avoid-repeat-rounds -1');
    check('rejects negative',         bad.includes('❌'), bad);
  }

  // ── set cadence ─────────────────────────────────────────────────────────────
  console.log('\nset cadence');
  {
    const ok = await runCmd('set cadence biweekly');
    check('accepts biweekly',         ok.includes('✅') && ok.includes('biweekly'), ok);

    const bad = await runCmd('set cadence daily');
    check('rejects unknown cadence',  bad.includes('❌'), bad);

    await runCmd('set cadence weekly'); // reset
  }

  // ── set channel ─────────────────────────────────────────────────────────────
  console.log('\nset channel');
  {
    const ok = await runCmd('set channel C01TESTCHAN');
    check('accepts channel ID',       ok.includes('✅') && ok.includes('C01TESTCHAN'), ok);

    const bad = await runCmd('set channel');
    check('rejects missing channel',  bad.includes('❌'), bad);
  }

  // ── set unknown setting ─────────────────────────────────────────────────────
  console.log('\nset (unknown / missing setting)');
  {
    const r1 = await runCmd('set foobar 123');
    check('unknown setting shows list', r1.includes('❌') && r1.includes('Available settings'), r1);

    const r2 = await runCmd('set');
    check('missing setting shows list', r2.includes('❌'), r2);
  }

  // ── exclude ─────────────────────────────────────────────────────────────────
  console.log('\nexclude');
  {
    // Slack-formatted mention: <@UDAVE00|dave>
    const r1 = await runCmd('exclude <@UDAVE00|dave>');
    check('excludes via Slack mention', r1.includes('✅') && r1.includes('UDAVE00'), r1);

    // Attempt to exclude the same user again
    const r2 = await runCmd('exclude <@UDAVE00|dave>');
    check('warns if already excluded',  r2.includes('⚠️'), r2);

    // Missing arg
    const r3 = await runCmd('exclude');
    check('rejects missing user arg',   r3.includes('❌'), r3);

    // Raw user ID (no angle brackets)
    const r4 = await runCmd('exclude UALICE0');
    check('excludes via raw user ID',   r4.includes('✅') && r4.includes('UALICE0'), r4);
  }

  // ── participants after exclusions ────────────────────────────────────────────
  console.log('\nparticipants after exclusions');
  {
    const r = await runCmd('participants');
    check('Alice excluded → not listed', !r.includes('Alice'), r);
    check('Dave excluded → not listed',  !r.includes('Dave'), r);
    check('Bob still eligible',          r.includes('Bob'), r);
  }

  // ── include ─────────────────────────────────────────────────────────────────
  console.log('\ninclude');
  {
    // Bare mention: <@UDAVE00>
    const r1 = await runCmd('include <@UDAVE00>');
    check('lifts exclusion via mention',  r1.includes('✅') && r1.includes('UDAVE00'), r1);

    const eligible = await runCmd('participants');
    check('Dave eligible again',          eligible.includes('Dave'), eligible);

    // Bob was never excluded
    const r2 = await runCmd('include UBOB000');
    check('warns if not excluded',        r2.includes('⚠️'), r2);

    // Missing arg
    const r3 = await runCmd('include');
    check('rejects missing user arg',     r3.includes('❌'), r3);
  }

  // ── Results ─────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));

  // Clean up test DB
  try { fs.unlinkSync(dbPath); } catch (_) {}

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
