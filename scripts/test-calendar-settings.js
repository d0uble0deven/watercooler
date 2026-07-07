'use strict';

// Phase 10 Step 2 — Calendar settings smoke test
//
// Verifies that the three new admin settings (calendar-enabled,
// meeting-duration, booking-deadline) can be read, written, and validated,
// and that show-settings displays them correctly.
//
// Run: npm run test:calendar-settings

// ── env before any require() ──────────────────────────────────────────────────
process.env.ADMIN_USER_IDS = 'UADMIN0';
process.env.DATABASE_PATH  = './data/test-calendar-settings.db';

const fs = require('node:fs');

fs.mkdirSync('./data', { recursive: true });
const dbPath = process.env.DATABASE_PATH;
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const { initDb }      = require('../src/db/init');
const { getSettings } = require('../src/lib/rounds');
const { handleAdmin } = require('../src/commands/admin/index');

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

async function runAdmin(text) {
  let response = null;
  await handleAdmin({ user_id: 'UADMIN0' }, text, async (msg) => { response = msg; }, null);
  return response;
}

async function main() {
  initDb();

  console.log('\n=== Phase 10 — Step 2: Calendar Settings Tests ===\n');

  // ── Default values seeded correctly ──────────────────────────────────────────
  console.log('Default settings after initDb()');
  {
    const s = getSettings();
    check('calendar_enabled defaults to 1',   s.calendar_enabled  === 1,    s.calendar_enabled);
    check('meeting_duration defaults to 15',  s.meeting_duration  === 15,   s.meeting_duration);
    check('booking_deadline defaults to 2.5', s.booking_deadline  === 2.5,  s.booking_deadline);
  }

  // ── set calendar-enabled ──────────────────────────────────────────────────────
  console.log('\nset calendar-enabled');
  {
    const r = await runAdmin('set calendar-enabled true');
    check('responds without throwing',    r !== null, r);
    check('confirms enabled',             r.includes('enabled'), r);
    check('DB updated to 1',              getSettings().calendar_enabled === 1);

    const r2 = await runAdmin('set calendar-enabled false');
    check('can disable again',            r2.includes('disabled'), r2);
    check('DB updated back to 0',         getSettings().calendar_enabled === 0);

    const bad = await runAdmin('set calendar-enabled yes');
    check('rejects invalid value',        bad.includes('❌'), bad);
    check('DB unchanged after bad input', getSettings().calendar_enabled === 0);
  }

  // ── set meeting-duration ──────────────────────────────────────────────────────
  console.log('\nset meeting-duration');
  {
    const r = await runAdmin('set meeting-duration 45');
    check('accepts 45 minutes',           r.includes('45'), r);
    check('DB updated to 45',             getSettings().meeting_duration === 45);

    const bad = await runAdmin('set meeting-duration 20');
    check('rejects 20 (not in list)',     bad.includes('❌'), bad);
    check('DB unchanged after bad input', getSettings().meeting_duration === 45);

    const bad2 = await runAdmin('set meeting-duration banana');
    check('rejects non-numeric value',    bad2.includes('❌'), bad2);
  }

  // ── set booking-deadline ──────────────────────────────────────────────────────
  console.log('\nset booking-deadline');
  {
    const r = await runAdmin('set booking-deadline 2.5');
    check('accepts 2.5 days',             r.includes('2.5'), r);
    check('mentions hours (52)',           r.includes('52'), r);
    check('DB updated to 2.5',            getSettings().booking_deadline === 2.5);

    const r2 = await runAdmin('set booking-deadline 1');
    check('accepts whole number 1',       r2.includes('1'), r2);
    check('DB updated to 1',              getSettings().booking_deadline === 1);

    const bad = await runAdmin('set booking-deadline 0.1');
    check('rejects value < 0.5',          bad.includes('❌'), bad);

    const bad2 = await runAdmin('set booking-deadline -1');
    check('rejects negative value',       bad2.includes('❌'), bad2);
  }

  // ── show settings includes calendar section ───────────────────────────────────
  console.log('\nadmin settings — shows calendar section');
  {
    const r = await runAdmin('settings');
    check('responds without throwing',        r !== null, r);
    check('shows calendar integration line',  r.includes('Calendar integration'), r);
    check('shows meeting duration line',      r.includes('Meeting duration'), r);
    check('shows booking deadline line',      r.includes('Booking deadline'), r);
    check('shows set calendar-enabled hint',  r.includes('calendar-enabled'), r);
    check('shows set meeting-duration hint',  r.includes('meeting-duration'), r);
    check('shows set booking-deadline hint',  r.includes('booking-deadline'), r);
  }

  // ── migration is idempotent (re-run initDb doesn't crash) ────────────────────
  console.log('\ninitDb() migration is idempotent');
  {
    let threw = false;
    try { initDb(); } catch (_) { threw = true; }
    check('second initDb() call does not throw', !threw);
    const s = getSettings();
    check('settings preserved after second init', s.booking_deadline === 1);
  }

  // ── Results ───────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));

  try { fs.unlinkSync(dbPath); } catch (_) {}
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
