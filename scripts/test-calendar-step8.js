'use strict';

// Phase 10 Step 8 — Polish unit tests
//
// Tests:
//   • withRetry()       — success on first try, retry-then-succeed, exhaust-and-throw,
//                         no-retry on non-transient errors
//   • isTransientError() — correct classification of error types
//   • calendar_timezone  — DB column exists and set/get round-trips correctly
//   • set calendar-timezone validation — accepts valid IANA tz, rejects garbage
//
// No Azure credentials or Slack tokens required.
//
// Run: npm run test:step8

process.env.ADMIN_USER_IDS = 'UADMIN0';
process.env.DATABASE_PATH  = './data/test-step8.db';

const fs = require('node:fs');
fs.mkdirSync('./data', { recursive: true });
const dbPath = process.env.DATABASE_PATH;
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const { initDb }          = require('../src/db/init');
const { getDb }           = require('../src/db/connection');
const { withRetry, isTransientError } = require('../src/lib/retryHelper');

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

console.log('\n=== Phase 10 — Step 8: Polish Tests ===\n');

// ── isTransientError ──────────────────────────────────────────────────────────
console.log('isTransientError()');

check('429 (rate limit) → transient',      isTransientError({ statusCode: 429 }));
check('503 (unavailable) → transient',     isTransientError({ statusCode: 503 }));
check('502 (bad gateway) → transient',     isTransientError({ statusCode: 502 }));
check('504 (gateway timeout) → transient', isTransientError({ statusCode: 504 }));
check('ECONNRESET → transient',            isTransientError({ code: 'ECONNRESET' }));
check('ETIMEDOUT → transient',             isTransientError({ code: 'ETIMEDOUT' }));
check('msg econnreset → transient',        isTransientError({ message: 'socket hang up: econnreset' }));

check('401 (auth) → NOT transient',        !isTransientError({ statusCode: 401 }));
check('403 (forbidden) → NOT transient',   !isTransientError({ statusCode: 403 }));
check('404 (not found) → NOT transient',   !isTransientError({ statusCode: 404 }));
check('400 (bad request) → NOT transient', !isTransientError({ statusCode: 400 }));
check('plain Error → NOT transient',       !isTransientError(new Error('something broke')));

// ── withRetry ─────────────────────────────────────────────────────────────────
// Async tests are wrapped in an IIFE so top-level await is not needed (CJS).
(async () => {
  // Use 0ms base delay so tests run instantly
  const ZERO_DELAY = 0;

  console.log('\nwithRetry()');

  // Succeeds on first try
  {
    let calls = 0;
    let result;
    let threw = false;
    try {
      result = await withRetry(async () => { calls++; return 'ok'; }, 3, ZERO_DELAY);
    } catch (_) { threw = true; }
    check('succeeds on first try — returns value',       result === 'ok',    result);
    check('succeeds on first try — called exactly once', calls  === 1,       calls);
    check('succeeds on first try — did not throw',       !threw);
  }

  // Retries on transient error, succeeds on 2nd attempt
  {
    let calls = 0;
    let result;
    try {
      result = await withRetry(async () => {
        calls++;
        if (calls < 2) throw Object.assign(new Error('rate limited'), { statusCode: 429 });
        return 'recovered';
      }, 3, ZERO_DELAY);
    } catch (_) {}
    check('retries on 429 — eventually returns value', result === 'recovered', result);
    check('retries on 429 — called exactly twice',     calls  === 2,           calls);
  }

  // Exhausts all attempts
  {
    let calls = 0;
    let thrown;
    try {
      await withRetry(async () => {
        calls++;
        throw Object.assign(new Error('service down'), { statusCode: 503 });
      }, 3, ZERO_DELAY);
    } catch (err) { thrown = err; }
    check('exhausts maxAttempts — throws',                  !!thrown);
    check('exhausts maxAttempts — tried 3 times',           calls === 3,               calls);
    check('exhausts maxAttempts — last error propagated',   thrown?.message === 'service down', thrown?.message);
  }

  // Non-transient error — throws immediately, no retry
  {
    let calls = 0;
    let thrown;
    try {
      await withRetry(async () => {
        calls++;
        throw Object.assign(new Error('not found'), { statusCode: 404 });
      }, 3, ZERO_DELAY);
    } catch (err) { thrown = err; }
    check('non-transient error — throws immediately', !!thrown);
    check('non-transient error — only 1 attempt',     calls === 1, calls);
  }

  // ── calendar_timezone DB column ─────────────────────────────────────────────
  console.log('\ncalendar_timezone DB column');

  initDb();

  {
    const db = getDb();

    // Default value from migration
    const row = db.prepare('SELECT calendar_timezone FROM settings LIMIT 1').get();
    check(
      "default timezone is 'America/New_York'",
      row?.calendar_timezone === 'America/New_York',
      row?.calendar_timezone,
    );

    // Can write and read back a different timezone
    db.prepare('UPDATE settings SET calendar_timezone = ? WHERE id = 1').run('America/Chicago');
    const updated = db.prepare('SELECT calendar_timezone FROM settings LIMIT 1').get();
    check(
      "can store and retrieve 'America/Chicago'",
      updated?.calendar_timezone === 'America/Chicago',
      updated?.calendar_timezone,
    );

    // Reset for clean state
    db.prepare('UPDATE settings SET calendar_timezone = ? WHERE id = 1').run('America/New_York');
  }

  // ── set calendar-timezone validation (pure Intl validation logic) ───────────
  console.log('\nset calendar-timezone validation (Intl)');
  {
    function isValidTimezone(tz) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
      } catch (_) {
        return false;
      }
    }

    check('America/New_York → valid',    isValidTimezone('America/New_York'));
    check('America/Chicago → valid',     isValidTimezone('America/Chicago'));
    check('America/Los_Angeles → valid', isValidTimezone('America/Los_Angeles'));
    check('Europe/London → valid',       isValidTimezone('Europe/London'));
    check('UTC → valid',                 isValidTimezone('UTC'));
    check('Foo/Bar → invalid',           !isValidTimezone('Foo/Bar'));
    check('empty string → invalid',      !isValidTimezone(''));
    check('random text → invalid',       !isValidTimezone('not a timezone'));
  }

  // ── Results ─────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));

  try { fs.unlinkSync(dbPath); } catch (_) {}
  if (failed > 0) process.exit(1);
})();
