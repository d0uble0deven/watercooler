'use strict';

// Phase 11 Step 6 — completion-fallback-days admin setting tests
//
// Tests:
//   • set completion-fallback-days validates input correctly
//   • valid value is stored in DB and read back
//   • show-settings includes the new line
//
// Run: npm run test:post6

process.env.ADMIN_USER_IDS = 'UADMIN0';
process.env.DATABASE_PATH  = './data/test-post6.db';

const fs = require('node:fs');
fs.mkdirSync('./data', { recursive: true });
const dbPath = process.env.DATABASE_PATH;
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const { initDb }        = require('../src/db/init');
const { getDb }         = require('../src/db/connection');
const { getSettings, updateSettings } = require('../src/lib/rounds');
const set               = require('../src/commands/admin/set');
const showSettings      = require('../src/commands/admin/show-settings');

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

// Capture respond() output
function makeRespond() {
  let output = '';
  const respond = async (msg) => { output = msg; };
  respond.get = () => output;
  return respond;
}

console.log('\n=== Phase 11 — Step 6: completion-fallback-days Setting Tests ===\n');

initDb();

// ── Default value ─────────────────────────────────────────────────────────────
console.log('Default value');
{
  const s = getSettings();
  check('defaults to 12', s.completion_fallback_days === 12, s.completion_fallback_days);
}

(async () => {
  const cmd = { user_id: 'UADMIN0' };

  // ── Validation: rejects invalid values ──────────────────────────────────────
  console.log('\nValidation — invalid values');
  for (const bad of ['0', '-1', 'abc', '']) {
    const r = makeRespond();
    await set(cmd, `completion-fallback-days ${bad}`, r);
    check(`rejects "${bad}"`, r.get().includes('❌'), r.get());
  }

  // ── Valid values are stored ────────────────────────────────────────────────
  console.log('\nValid values');
  {
    const r = makeRespond();
    await set(cmd, 'completion-fallback-days 10', r);
    check('accepts 10',           r.get().includes('✅'), r.get());
    check('confirms 10 biz days', r.get().includes('10'), r.get());

    const s = getSettings();
    check('DB stores 10',         s.completion_fallback_days === 10, s.completion_fallback_days);

    // Singular grammar — check only the first line to avoid "business days" in the footnote
    await set(cmd, 'completion-fallback-days 1', r);
    const firstLine = r.get().split('\n')[0];
    check('accepts 1',            r.get().includes('✅'));
    check('uses singular "day"',  firstLine.includes('1 business day'), firstLine);

    // Reset to default
    updateSettings({ completion_fallback_days: 12 });
  }

  // ── show-settings includes the line ─────────────────────────────────────────
  console.log('\nshow-settings output');
  {
    const r = makeRespond();
    await showSettings({}, r);
    const output = r.get();
    check('contains Completion fallback line', output.includes('Completion fallback'), output.slice(0, 100));
    check('shows 12 business days',            output.includes('12 business days'), output);
  }

  // ── Results ──────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));

  try { fs.unlinkSync(dbPath); } catch (_) {}
  if (failed > 0) process.exit(1);
})();
