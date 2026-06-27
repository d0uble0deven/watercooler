'use strict';

// Fun fact tests
//
// Covers:
//   • the content list (non-empty, unique, sane length)
//   • pickFunFact      — random, respects exclude set, fallback when all excluded
//   • assignFunFact    — stores on match, avoids repeats within a round
//   • buildEventBodyHtml — injects the fact line, omits when absent, escapes HTML
//
// Run: npm run test:fun-facts

const { initDb } = require('../src/db/init');
initDb();

const { FUN_FACTS } = require('../src/data/funFacts');
const { pickFunFact, assignFunFact } = require('../src/lib/funFacts');
const { buildEventBodyHtml } = require('../src/integrations/calendarBooker');
const { createRound, saveMatch, getMatchesForRound, getUsedFunFactsForRound } = require('../src/lib/rounds');
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

console.log('\n=== Fun Fact Tests ===\n');

(async () => {

  // ── Content list ────────────────────────────────────────────────────────────
  console.log('content list');
  {
    check('list is non-empty',         FUN_FACTS.length > 0);
    check('all facts are unique',      new Set(FUN_FACTS).size === FUN_FACTS.length);
    check('all are non-empty strings', FUN_FACTS.every((f) => typeof f === 'string' && f.trim().length > 0));
    check('all reasonably short (<200 chars)', FUN_FACTS.every((f) => f.length < 200));
  }

  // ── pickFunFact ─────────────────────────────────────────────────────────────
  console.log('\npickFunFact');
  {
    check('returns a fact from the list', FUN_FACTS.includes(pickFunFact([])));

    // exclude all but one → must return that one
    const keep = FUN_FACTS[7];
    const excludeAllButOne = FUN_FACTS.filter((f) => f !== keep);
    const picks = new Set();
    for (let i = 0; i < 30; i++) picks.add(pickFunFact(excludeAllButOne));
    check('respects exclude set', picks.size === 1 && picks.has(keep));

    // accepts a Set too
    check('accepts a Set as exclude', pickFunFact(new Set(excludeAllButOne)) === keep);

    // fallback: everything excluded → still returns something
    check('fallback when all excluded', FUN_FACTS.includes(pickFunFact(FUN_FACTS)));
  }

  // ── assignFunFact ───────────────────────────────────────────────────────────
  console.log('\nassignFunFact (within a round)');
  {
    const rid = createRound('test-fun-facts');
    const ids = Array.from({ length: 6 }, () => saveMatch(rid));
    const assigned = ids.map((id) => assignFunFact(id, rid));

    check('returns a fact per match',     assigned.every((f) => typeof f === 'string'));
    check('all distinct within the round', new Set(assigned).size === assigned.length);
    check('stored on every match row',     getMatchesForRound(rid).every((m) => m.fun_fact));
    check('used-list matches assignments', getUsedFunFactsForRound(rid).length === ids.length);

    // cleanup
    getDb().prepare('DELETE FROM matches WHERE round_id = ?').run(rid);
    getDb().prepare('DELETE FROM rounds WHERE id = ?').run(rid);
  }

  // ── buildEventBodyHtml injection ────────────────────────────────────────────
  console.log('\nbuildEventBodyHtml');
  {
    const users = [{ display_name: 'Alice' }, { display_name: 'Bob' }];

    const withFact = buildEventBodyHtml(users, 'Sea otters hold hands while they sleep.');
    check('includes the Conversation starter label', withFact.includes('Conversation starter'));
    check('includes the fact text',                  withFact.includes('Sea otters hold hands'));

    const without = buildEventBodyHtml(users, null);
    check('omits the line when no fact given', !without.includes('Conversation starter'));

    const escaped = buildEventBodyHtml(users, 'A & B <tag>');
    check('HTML-escapes the fact text', escaped.includes('A &amp; B &lt;tag&gt;'));
  }

  // ── Results ──────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(42)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(42));

  if (failed > 0) process.exit(1);
})();
