'use strict';

// Handles: /watercooler admin run
//
// Full matching run:
//   1. Duplicate-round guard
//   2. Fetch eligible users + settings + pair history
//   3. Run matching engine
//   4. Create round record in DB
//   5. For each group: open Slack DM → post intro → persist to DB
//   6. Complete round
//   7. Report summary to admin
//
// Error handling: if a single group fails (Slack error), we log it, skip it,
// and continue. The round still completes. Partial success is better than a
// half-aborted run that leaves the state ambiguous.

const {
  getEligibleUsers,
  getSettings,
  getRecentPairHistory,
  isRoundInProgress,
  createRound,
  saveMatch,
  saveMatchMembers,
  savePairHistory,
  completeRound,
  updateMatchChannel,
} = require('../../lib/rounds');

const { createMatches }                    = require('../../matching/engine');
const { openGroupDm, postIntroMessage }    = require('../../slack/messaging');

async function run(command, respond, client) {

  // ── 1. Duplicate-round guard ───────────────────────────────────────────────
  if (isRoundInProgress()) {
    await respond(
      '⚠️ A round is already in progress.\n' +
      'Wait for it to finish before starting another. If it appears stuck, check the `rounds` table in the database.'
    );
    return;
  }

  // ── 2. Pre-flight checks ───────────────────────────────────────────────────
  const settings = getSettings();
  const eligible = getEligibleUsers();

  if (eligible.length === 0) {
    await respond(
      '❌ No eligible participants found — nobody to match.\n' +
      'Have people join with `/watercooler join`, then try again.\n' +
      'Use `/watercooler admin dry-run` to preview who would be included.'
    );
    return;
  }

  if (eligible.length === 1) {
    await respond(
      `❌ Only 1 eligible participant (*${eligible[0].display_name}*) — need at least 2 to form a match.`
    );
    return;
  }

  // ── 3. Generate matches ────────────────────────────────────────────────────
  const history = getRecentPairHistory(settings.avoid_repeat_rounds);
  const groups  = createMatches(eligible, history, { groupSize: settings.group_size });

  // Acknowledge immediately — tells the admin something is happening
  await respond(
    `🚀 Starting Watercooler round — *${eligible.length} participants* → *${groups.length} groups*...`
  );

  // ── 4. Create round record ─────────────────────────────────────────────────
  const roundId = createRound(command.user_id);
  console.log(`[admin run] Created round ${roundId} by ${command.user_id}`);

  // ── 5. Process each group ──────────────────────────────────────────────────
  let successCount = 0;
  const failures   = [];

  for (const group of groups) {
    const names   = group.users.map((u) => u.display_name).join(', ');
    const userIds = group.users.map((u) => u.slack_user_id);

    try {
      // Open (or retrieve) the Slack DM channel
      const channelId = await openGroupDm(client, userIds);

      // Post the intro message
      await postIntroMessage(client, channelId, group.users);

      // Persist everything to the database
      const matchId = saveMatch(roundId);
      saveMatchMembers(matchId, group.users.map((u) => u.id));
      savePairHistory(roundId, group.users);
      updateMatchChannel(matchId, channelId);

      successCount++;
      console.log(`[admin run] ✅ Matched: ${names} → channel ${channelId}`);

    } catch (err) {
      console.error(`[admin run] ❌ Failed to process group [${names}]:`, err.message);
      failures.push(names);
    }
  }

  // ── 6. Complete round ──────────────────────────────────────────────────────
  completeRound(roundId);
  console.log(`[admin run] Round ${roundId} completed. ${successCount} ok, ${failures.length} failed.`);

  // ── 7. Report to admin ─────────────────────────────────────────────────────
  if (failures.length === 0) {
    await respond(
      `✅ *Round complete!*\n` +
      `${successCount} group(s) matched and notified.\n` +
      `_Round #${roundId} — use \`/watercooler admin recent-rounds\` to see history._`
    );
  } else {
    await respond(
      `⚠️ *Round finished with errors*\n` +
      `✅ ${successCount} group(s) succeeded.\n` +
      `❌ ${failures.length} group(s) failed — check server logs for details:\n` +
      failures.map((f) => `  • ${f}`).join('\n')
    );
  }
}

module.exports = run;
