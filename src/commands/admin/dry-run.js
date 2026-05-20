'use strict';

// Handles: /watercooler admin dry-run
//
// Fetches eligible users and recent pair history, runs the matching engine,
// and shows a preview of who would be grouped together.
//
// ZERO side effects:
//   - No round is created in the DB
//   - No match records are saved
//   - No Slack DMs are opened
//   - No messages are sent to anyone

const { getEligibleUsers, getSettings, getRecentPairHistory } = require('../../lib/rounds');
const { createMatches } = require('../../matching/engine');

async function dryRun(command, respond) {
  const settings = getSettings();
  const eligible = getEligibleUsers();
  const history  = getRecentPairHistory(settings.avoid_repeat_rounds);

  // ── Edge cases ──────────────────────────────────────────────────────────────

  if (eligible.length === 0) {
    await respond(
      '🔍 *Dry run — no eligible participants*\n' +
      'Nobody is currently active and unpaused. Have people join with `/watercooler join`.'
    );
    return;
  }

  if (eligible.length === 1) {
    await respond(
      `🔍 *Dry run — only 1 eligible participant*\n` +
      `*${eligible[0].display_name}* is the only active member — need at least 2 to form a match.`
    );
    return;
  }

  // ── Run the matching engine (pure — no side effects) ───────────────────────

  const groups = createMatches(eligible, history, { groupSize: settings.group_size });

  // ── Format the preview ─────────────────────────────────────────────────────

  const groupLines = groups.map((group, i) => {
    const names  = group.users.map((u) => `*${u.display_name}*`).join(', ');
    const isTrio = group.users.length === 3;
    const repeat = hasRepeatPairing(group.users, history);

    const tags = [
      isTrio  ? '_(trio)_'   : null,
      repeat  ? '⚠️ _(repeat)_' : null,
    ].filter(Boolean).join(' ');

    return `${i + 1}. ${names}${tags ? `  ${tags}` : ''}`;
  });

  const repeatCount = groups.filter((g) => hasRepeatPairing(g.users, history)).length;
  const repeatWarning = repeatCount > 0
    ? `\n⚠️ _${repeatCount} group(s) contain a repeat pairing — fresh combinations exhausted for those users._`
    : '';

  const lines = [
    `🔍 *Dry run — Watercooler match preview*`,
    `_${eligible.length} eligible participants → ${groups.length} ${groups.length === 1 ? 'group' : 'groups'}_`,
    `_No DMs will be sent. Run \`/watercooler admin run\` to execute for real._`,
    ``,
    ...groupLines,
  ];

  if (repeatWarning) lines.push(repeatWarning);

  await respond(lines.join('\n'));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if any pair within the group appears in pairHistory.
 * Used to flag repeat pairings in the preview output.
 */
function hasRepeatPairing(users, pairHistory) {
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      const a = users[i].id;
      const b = users[j].id;
      const isRepeat = pairHistory.some(
        (h) =>
          (h.userAId === a && h.userBId === b) ||
          (h.userAId === b && h.userBId === a)
      );
      if (isRepeat) return true;
    }
  }
  return false;
}

module.exports = dryRun;
