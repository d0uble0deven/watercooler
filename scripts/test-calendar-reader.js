'use strict';

// Phase 10 Step 3 — Calendar reader smoke test
//
// Tests getFreeBusy() and its helpers using a mock Graph client.
// No Azure credentials required — all Graph responses are simulated.
//
// Run: npm run test:calendar-reader

const { getFreeBusy, toGraphDateTime, parseResponse } = require('../src/integrations/calendarReader');

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

// ── Mock Graph client factory ─────────────────────────────────────────────────
// Simulates client.api(path).post(body) → { value: [...] }

function mockClient(responseValue) {
  return {
    api: (_path) => ({
      post: async (_body) => ({ value: responseValue }),
    }),
  };
}

function errorClient(message) {
  return {
    api: (_path) => ({
      post: async (_body) => { throw new Error(message); },
    }),
  };
}

// ── Shared test fixtures ──────────────────────────────────────────────────────

const T = {
  start: new Date('2025-06-09T09:00:00Z'),  // Monday 9 AM UTC
  end:   new Date('2025-06-09T17:00:00Z'),  // Monday 5 PM UTC
};

// A realistic Graph getSchedule response item
function makeScheduleItem(email, items = []) {
  return {
    scheduleId:    email,
    scheduleItems: items,
    availabilityView: '000222000000000',
  };
}

function makeItem(startISO, endISO, status) {
  return {
    status,
    start: { dateTime: startISO, timeZone: 'UTC' },
    end:   { dateTime: endISO,   timeZone: 'UTC' },
  };
}

async function main() {
  console.log('\n=== Phase 10 — Step 3: Calendar Reader Tests ===\n');

  // ── toGraphDateTime ───────────────────────────────────────────────────────────
  console.log('toGraphDateTime()');
  {
    const result = toGraphDateTime(new Date('2025-06-09T10:30:00.000Z'));
    check('strips milliseconds and Z',    result === '2025-06-09T10:30:00', result);
    check('output has no trailing Z',     !result.endsWith('Z'), result);
    check('output has no milliseconds',   !result.includes('.'), result);
  }

  // ── null / missing guard ──────────────────────────────────────────────────────
  console.log('\ngetFreeBusy() — null / empty inputs');
  {
    const r1 = await getFreeBusy(null, ['a@b.com'], T.start, T.end);
    check('null client → empty array',          Array.isArray(r1) && r1.length === 0, r1);

    const r2 = await getFreeBusy(mockClient([]), [], T.start, T.end);
    check('empty emails array → empty array',   Array.isArray(r2) && r2.length === 0, r2);

    const r3 = await getFreeBusy(mockClient([]), null, T.start, T.end);
    check('null emails → empty array',          Array.isArray(r3) && r3.length === 0, r3);
  }

  // ── user with no events ───────────────────────────────────────────────────────
  console.log('\ngetFreeBusy() — user with no events');
  {
    const client = mockClient([makeScheduleItem('alice@docme360.com', [])]);
    const result = await getFreeBusy(client, ['alice@docme360.com'], T.start, T.end);

    check('returns one entry',            result.length === 1, result.length);
    check('email matches',                result[0].email === 'alice@docme360.com', result[0].email);
    check('busySlots is empty array',     result[0].busySlots.length === 0, result[0].busySlots);
  }

  // ── busy and tentative slots included ────────────────────────────────────────
  console.log('\ngetFreeBusy() — blocking statuses (busy, tentative, oof)');
  {
    const client = mockClient([makeScheduleItem('bob@docme360.com', [
      makeItem('2025-06-09T10:00:00.0000000', '2025-06-09T11:00:00.0000000', 'busy'),
      makeItem('2025-06-09T13:00:00.0000000', '2025-06-09T13:30:00.0000000', 'tentative'),
      makeItem('2025-06-09T15:00:00.0000000', '2025-06-09T17:00:00.0000000', 'oof'),
    ])]);
    const result = await getFreeBusy(client, ['bob@docme360.com'], T.start, T.end);
    const slots  = result[0].busySlots;

    check('returns 3 blocking slots',     slots.length === 3, slots.length);
    check('first slot status is busy',    slots[0].status === 'busy', slots[0].status);
    check('second slot is tentative',     slots[1].status === 'tentative', slots[1].status);
    check('third slot is oof',            slots[2].status === 'oof', slots[2].status);
    check('start is a JS Date',           slots[0].start instanceof Date, typeof slots[0].start);
    check('end is a JS Date',             slots[0].end instanceof Date, typeof slots[0].end);
    check('busy slot start is 10 AM UTC', slots[0].start.getUTCHours() === 10, slots[0].start.toISOString());
    check('busy slot end is 11 AM UTC',   slots[0].end.getUTCHours()   === 11, slots[0].end.toISOString());
    // Graph returns 7-decimal-place seconds — verify we parse them correctly
    check('7-decimal seconds parse OK',   slots[1].start.getUTCHours() === 13, slots[1].start.toISOString());
  }

  // ── free / workingElsewhere filtered out ──────────────────────────────────────
  console.log('\ngetFreeBusy() — non-blocking statuses (free, workingElsewhere)');
  {
    const client = mockClient([makeScheduleItem('carol@docme360.com', [
      makeItem('2025-06-09T09:00:00.0000000', '2025-06-09T10:00:00.0000000', 'free'),
      makeItem('2025-06-09T14:00:00.0000000', '2025-06-09T15:00:00.0000000', 'workingElsewhere'),
    ])]);
    const result = await getFreeBusy(client, ['carol@docme360.com'], T.start, T.end);

    check('free slot is filtered out',           result[0].busySlots.length === 0, result[0].busySlots);
  }

  // ── multiple users ────────────────────────────────────────────────────────────
  console.log('\ngetFreeBusy() — multiple users in one call');
  {
    const client = mockClient([
      makeScheduleItem('alice@docme360.com', [
        makeItem('2025-06-09T10:00:00.0000000', '2025-06-09T11:00:00.0000000', 'busy'),
      ]),
      makeScheduleItem('bob@docme360.com', []),
      makeScheduleItem('carol@docme360.com', [
        makeItem('2025-06-09T14:00:00.0000000', '2025-06-09T15:00:00.0000000', 'tentative'),
      ]),
    ]);

    const emails = ['alice@docme360.com', 'bob@docme360.com', 'carol@docme360.com'];
    const result = await getFreeBusy(client, emails, T.start, T.end);

    check('returns 3 users',              result.length === 3, result.length);
    check('alice has 1 busy slot',        result[0].busySlots.length === 1, result[0].busySlots.length);
    check('bob has 0 busy slots',         result[1].busySlots.length === 0, result[1].busySlots.length);
    check('carol has 1 tentative slot',   result[2].busySlots.length === 1, result[2].busySlots.length);
  }

  // ── Graph API error is caught gracefully ──────────────────────────────────────
  console.log('\ngetFreeBusy() — Graph API error handling');
  {
    const result = await getFreeBusy(
      errorClient('Unauthorized'),
      ['alice@docme360.com', 'bob@docme360.com'],
      T.start, T.end
    );

    check('error does not throw',                 Array.isArray(result), result);
    check('returns one entry per email on error', result.length === 2, result.length);
    check('entries have empty busySlots',         result.every((r) => r.busySlots.length === 0));
  }

  // ── parseResponse with empty/null value ───────────────────────────────────────
  console.log('\nparseResponse() — edge cases');
  {
    check('null response → empty array',       parseResponse(null).length === 0);
    check('missing value → empty array',       parseResponse({}).length === 0);
    check('empty value array → empty array',   parseResponse({ value: [] }).length === 0);
  }

  // ── Results ───────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
