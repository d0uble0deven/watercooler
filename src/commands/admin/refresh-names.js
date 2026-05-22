'use strict';

// Handles: /watercooler admin refresh-names
//
// Loops through every user in the DB, calls Slack's users.info, and updates
// display_name to the real name from their Slack profile.
//
// Use this once after the initial deployment to fix any usernames (e.g.
// "dev.govindji") that were stored before the join command was updated to
// prefer real names. Going forward, join and the calendar flow auto-heal names.

const { getAllUsers, updateUser } = require('../../lib/users');

async function refreshNames(command, respond, client) {
  const users = getAllUsers();

  if (users.length === 0) {
    await respond('ℹ️ No users in the database yet.');
    return;
  }

  await respond(`🔄 Refreshing display names for *${users.length}* user(s)…`);

  let updated = 0;
  let skipped = 0;
  let failed  = 0;

  for (const user of users) {
    try {
      const result  = await client.users.info({ user: user.slack_user_id });
      const realName = result?.user?.profile?.real_name
                    || result?.user?.profile?.display_name;

      if (!realName) { skipped++; continue; }

      if (realName !== user.display_name) {
        updateUser(user.slack_user_id, { display_name: realName });
        console.log(`[refresh-names] "${user.display_name}" → "${realName}"`);
        updated++;
      } else {
        skipped++; // already correct
      }
    } catch (err) {
      console.warn(`[refresh-names] Failed for ${user.slack_user_id}:`, err.message);
      failed++;
    }
  }

  const parts = [`✅ *Display names refreshed!*`];
  if (updated > 0) parts.push(`• *${updated}* updated`);
  if (skipped > 0) parts.push(`• ${skipped} already correct`);
  if (failed  > 0) parts.push(`• ⚠️ ${failed} failed (check server logs)`);

  await respond(parts.join('\n'));
}

module.exports = refreshNames;
