'use strict';

// Fun fact selection for calendar invites.
//
// Facts themselves live in src/data/funFacts.js (version-controlled — add more
// there anytime). This module picks one at random per meeting, skipping any
// already used by another match in the same round so a round gets variety.
//
// Usage is recorded simply by storing the chosen fact on the match row
// (matches.fun_fact) — no separate tracking table, nothing to migrate.

const { FUN_FACTS } = require('../data/funFacts');
const { getUsedFunFactsForRound, saveFunFact } = require('./rounds');

/**
 * Picks a random fact not present in `exclude`. If every fact is excluded
 * (e.g. a round larger than the list), falls back to a plain random pick so
 * this never fails to return something.
 *
 * @param {Set<string>|string[]} exclude  facts to avoid
 * @returns {string|null} a fact, or null if the list is empty
 */
function pickFunFact(exclude = []) {
  if (FUN_FACTS.length === 0) return null;
  const excludeSet = exclude instanceof Set ? exclude : new Set(exclude);

  const available = FUN_FACTS.filter((f) => !excludeSet.has(f));
  const pool = available.length > 0 ? available : FUN_FACTS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Draws a fact for a match, avoiding facts already used in that round, stores
 * it on the match, and returns it. Called at booking time.
 *
 * @param {number} matchId
 * @param {number} roundId
 * @returns {string|null}
 */
function assignFunFact(matchId, roundId) {
  const used = getUsedFunFactsForRound(roundId);
  const fact = pickFunFact(used);
  if (fact) saveFunFact(matchId, fact);
  return fact;
}

module.exports = { pickFunFact, assignFunFact };
