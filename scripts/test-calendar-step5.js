'use strict';

// Phase 10 Step 5 — Interactive DM unit tests
//
// Tests the pure helper functions in calendarScheduler and the updated
// slotFinder (weekdaysOnly). No Azure credentials or Slack tokens required.
//
// Run: npm run test:step5

const {
  buildSearchWindow,
  buildSuggestionsMessage,
  formatSlotLabel,
  nextBusinessDay,
  addBusinessDays,
} = require('../src/integrations/calendarScheduler');

const { findSlots, isWeekday } = require('../src/lib/slotFinder');

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

// UTC date helpers
const D = (iso) => new Date(iso);

console.log('\n=== Phase 10 — Step 5: Interactive DM Tests ===\n');

// ── isWeekday ─────────────────────────────────────────────────────────────────
console.log('isWeekday()');
{
  check('Monday is weekday',    isWeekday(D('2025-06-09T12:00:00Z')));  // Mon
  check('Tuesday is weekday',   isWeekday(D('2025-06-10T12:00:00Z')));  // Tue
  check('Wednesday is weekday', isWeekday(D('2025-06-11T12:00:00Z')));  // Wed
  check('Thursday is weekday',  isWeekday(D('2025-06-12T12:00:00Z')));  // Thu
  check('Friday is weekday',    isWeekday(D('2025-06-13T12:00:00Z')));  // Fri
  check('Saturday is NOT weekday', !isWeekday(D('2025-06-14T12:00:00Z')));  // Sat
  check('Sunday is NOT weekday',   !isWeekday(D('2025-06-15T12:00:00Z')));  // Sun
}

// ── findSlots weekdaysOnly (default true) ─────────────────────────────────────
console.log('\nfindSlots() — weekdaysOnly skips Saturday/Sunday');
{
  // Window: Fri Jun 13 to Mon Jun 16 (spans weekend)
  const fri9am  = D('2025-06-13T09:00:00Z');
  const mon5pm  = D('2025-06-16T17:00:00Z');

  // With weekdaysOnly: true (default) — only Friday and Monday slots returned
  const slots = findSlots([], fri9am, mon5pm, 30, { maxSlots: 20 });
  check('no Saturday slots',   slots.every((s) => s.start.getUTCDay() !== 6));
  check('no Sunday slots',     slots.every((s) => s.start.getUTCDay() !== 0));
  check('has Friday slots',    slots.some((s)  => s.start.getUTCDay() === 5));
  check('has Monday slots',    slots.some((s)  => s.start.getUTCDay() === 1));

  // With weekdaysOnly: false — weekend slots would appear
  const slotsAll = findSlots([], fri9am, mon5pm, 30, { maxSlots: 20, weekdaysOnly: false });
  check('weekdaysOnly:false includes weekends', slotsAll.some((s) => [0, 6].includes(s.start.getUTCDay())));
}

// ── nextBusinessDay ───────────────────────────────────────────────────────────
console.log('\nnextBusinessDay()');
{
  // Friday → Monday (skips Sat+Sun)
  const fri = D('2025-06-13T15:00:00Z');
  const nbd = nextBusinessDay(fri);
  check('Friday → next Monday',      nbd.getUTCDay() === 1, nbd.toISOString());
  check('Next Monday is June 16',    nbd.toISOString().startsWith('2025-06-16'));

  // Saturday → Monday
  const sat = D('2025-06-14T10:00:00Z');
  const nbd2 = nextBusinessDay(sat);
  check('Saturday → next Monday',    nbd2.getUTCDay() === 1, nbd2.toISOString());

  // Monday → Tuesday
  const mon = D('2025-06-09T10:00:00Z');
  const nbd3 = nextBusinessDay(mon);
  check('Monday → Tuesday',          nbd3.getUTCDay() === 2, nbd3.toISOString());
}

// ── addBusinessDays ───────────────────────────────────────────────────────────
console.log('\naddBusinessDays()');
{
  // Monday + 5 business days = next Monday
  const mon = D('2025-06-09T09:00:00Z');
  const result = addBusinessDays(mon, 5);
  check('Mon + 5 biz days = next Mon',  result.getUTCDay() === 1, result.toISOString());
  check('Jun 9 + 5 biz days = Jun 16',  result.toISOString().startsWith('2025-06-16'));

  // Wednesday + 3 biz days = Monday (skips weekend)
  const wed = D('2025-06-11T09:00:00Z');
  const result2 = addBusinessDays(wed, 3);
  check('Wed Jun 11 + 3 biz days = Mon Jun 16', result2.toISOString().startsWith('2025-06-16'));
}

// ── buildSearchWindow ─────────────────────────────────────────────────────────
console.log('\nbuildSearchWindow()');
{
  // Called on a Monday — start should be Tuesday
  const monday = D('2025-06-09T14:00:00Z');
  const { start, end } = buildSearchWindow(monday);

  check('start is a Date',               start instanceof Date);
  check('end is a Date',                 end instanceof Date);
  check('start is a weekday',            isWeekday(start), start.toISOString());
  check('start is not a weekend',        start.getUTCDay() !== 0 && start.getUTCDay() !== 6);
  check('start is at 09:00 UTC',         start.getUTCHours() === 9 && start.getUTCMinutes() === 0);
  check('end is at 17:00 UTC',           end.getUTCHours() === 17 && end.getUTCMinutes() === 0);
  check('end is after start',            end > start);
  check('window spans ~5 business days', end - start >= 4 * 24 * 60 * 60 * 1000);

  // Called on a Friday — start should be next Monday
  const friday = D('2025-06-13T18:00:00Z');
  const { start: monStart } = buildSearchWindow(friday);
  check('Friday call → start is Monday', monStart.getUTCDay() === 1, monStart.toISOString());
}

// ── formatSlotLabel ───────────────────────────────────────────────────────────
console.log('\nformatSlotLabel()');
{
  // 9:00–9:30 AM UTC on Monday
  const slot = {
    start: D('2025-06-09T09:00:00Z'),
    end:   D('2025-06-09T09:30:00Z'),
  };

  // UTC timezone — straightforward
  const label = formatSlotLabel(slot, 'UTC');
  check('label is a string',              typeof label === 'string', label);
  check('label contains day of week',     label.includes('Mon'), label);
  check('label contains month',           label.includes('Jun'), label);
  check('label contains day number',      label.includes('9'), label);
  check('label contains AM',              label.toUpperCase().includes('AM'), label);
  check('label contains dash separator',  label.includes('–'), label);

  // 60-min slot: 14:00–15:00 UTC
  const slot2 = {
    start: D('2025-06-09T14:00:00Z'),
    end:   D('2025-06-09T15:00:00Z'),
  };
  const label2 = formatSlotLabel(slot2, 'UTC');
  check('2 PM slot contains PM',  label2.toUpperCase().includes('PM'), label2);
}

// ── buildSuggestionsMessage ───────────────────────────────────────────────────
console.log('\nbuildSuggestionsMessage()');
{
  const slots = [
    { start: D('2025-06-09T09:00:00Z'), end: D('2025-06-09T09:30:00Z') },
    { start: D('2025-06-09T10:00:00Z'), end: D('2025-06-09T10:30:00Z') },
    { start: D('2025-06-09T14:00:00Z'), end: D('2025-06-09T14:30:00Z') },
  ];
  const matchId = 42;
  const blocks  = buildSuggestionsMessage(slots, matchId, 'UTC');

  check('returns an array',                    Array.isArray(blocks), typeof blocks);
  check('has at least 3 blocks',               blocks.length >= 3, blocks.length);

  // Section block
  const section = blocks.find((b) => b.type === 'section');
  check('has a section block',                 !!section);
  check('section mentions booking',            section?.text?.text?.includes('book') ?? false, section?.text?.text);

  // Actions block with buttons
  const actions = blocks.find((b) => b.type === 'actions');
  check('has an actions block',                !!actions);
  check('actions block has 3 buttons',         actions?.elements?.length === 3, actions?.elements?.length);
  check('buttons are type "button"',           actions?.elements?.every((e) => e.type === 'button'));

  // Button structure
  const btn0 = actions?.elements?.[0];
  check('first button action_id is watercooler_book_slot_0', btn0?.action_id === 'watercooler_book_slot_0', btn0?.action_id);
  check('first button has primary style',      btn0?.style === 'primary', btn0?.style);
  check('button value encodes start ISO',      btn0?.value?.includes('2025-06-09T09:00:00.000Z'), btn0?.value);
  check('button value encodes end ISO',        btn0?.value?.includes('2025-06-09T09:30:00.000Z'), btn0?.value);
  check('button value encodes matchId',        btn0?.value?.includes('42'), btn0?.value);
  check('button value has pipe delimiters',    btn0?.value?.split('|').length === 3, btn0?.value);

  // Context block
  const context = blocks.find((b) => b.type === 'context');
  check('has a context block',                 !!context);
  check('context mentions UTC',                context?.elements?.[0]?.text?.includes('UTC'), context?.elements?.[0]?.text);
}

// ── Results ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(42)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(42));

if (failed > 0) process.exit(1);
