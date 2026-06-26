'use strict';

// Handles: /watercooler admin sync-channel
//
// One-time (re-runnable) backfill for channel-based enrollment. The join/leave
// events only catch *future* membership changes, so this enrolls everyone who
// is ALREADY sitting in the intro channel.
//
// Safe to run repeatedly — already-active members are no-ops with no DM.
//
// Also prints a "drift" report: anyone active in the DB who is NOT in the
// channel (e.g. people who joined via slash command before this feature). It
// only reports them — it never auto-removes anyone.

const { getSettings }    = require('../../lib/rounds');
const { getActiveUsers } = require('../../lib/users');
const { enrollUser }     = require('../../lib/enrollment');

async function syncChannel(command, respond, client) {
  const settings = getSettings();

  // ── Guards ──────────────────────────────────────────────────────────────────
  if (settings.enrollment_mode !== 'channel') {
    await respond('❌ Channel enrollment is off. Turn it on first: `/watercooler admin set enrollment channel`.');
    return;
  }
  if (!settings.intro_channel_id) {
    await respond('❌ No intro channel is set. Set one first: `/watercooler admin set channel <channel-id>`.');
    return;
  }

  const channelId = settings.intro_channel_id;

  // ── Fetch all channel members (paginated) ───────────────────────────────────
  let memberIds;
  try {
    memberIds = await fetchAllMembers(client, channelId);
  } catch (err) {
    console.error('[sync-channel] Could not fetch members:', err.message);
    await respond(
      `❌ Couldn't read members of <#${channelId}>: _${err.message}_\n` +
      'Make sure the bot is a member of that channel and has the `channels:read` scope.'
    );
    return;
  }

  await respond(`⏳ Syncing <#${channelId}> — ${memberIds.length} member(s) found. Enrolling…`);

  // ── Enroll each, tally outcomes ─────────────────────────────────────────────
  const tally = {
    enrolled: 0, reactivated: 0, already_active: 0,
    skipped_bot: 0, skipped_guest: 0, skipped_excluded: 0, skipped_error: 0,
  };
  for (const id of memberIds) {
    const status = await enrollUser(client, id, 'sync');
    if (tally[status] !== undefined) tally[status]++;
  }

  // ── Drift: active DB users not in the channel (report only) ──────────────────
  const memberSet = new Set(memberIds);
  const drift = getActiveUsers().filter((u) => !memberSet.has(u.slack_user_id));

  // ── Build summary ───────────────────────────────────────────────────────────
  const lines = [
    `✅ *Channel sync complete for <#${channelId}>*`,
    `• ${tally.enrolled} enrolled${tally.enrolled ? ' (welcome DMs sent)' : ''} · ` +
    `${tally.reactivated} reactivated · ${tally.already_active} already active`,
  ];

  const skips = [];
  if (tally.skipped_bot)      skips.push(`${tally.skipped_bot} bot(s)`);
  if (tally.skipped_guest)    skips.push(`${tally.skipped_guest} guest(s)`);
  if (tally.skipped_excluded) skips.push(`${tally.skipped_excluded} excluded`);
  if (tally.skipped_error)    skips.push(`${tally.skipped_error} unreadable`);
  if (skips.length) lines.push(`• Skipped: ${skips.join(' · ')}`);

  if (drift.length > 0) {
    lines.push('');
    lines.push(`⚠️ *${drift.length} active participant(s) are NOT in <#${channelId}>:*`);
    lines.push(drift.map((u) => `• ${u.display_name}`).join('\n'));
    lines.push(
      '_Likely joined before channel enrollment existed. They stay enrolled — ' +
      'ask them to join the channel, or use `/watercooler admin exclude @user` ' +
      'if you want the channel to be the single source of truth._'
    );
  }

  await respond(lines.join('\n'));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns every member ID of a channel, following pagination cursors.
async function fetchAllMembers(client, channelId) {
  const ids = [];
  let cursor;
  do {
    const res = await client.conversations.members({ channel: channelId, limit: 200, cursor });
    ids.push(...(res.members || []));
    cursor = res.response_metadata?.next_cursor || '';
  } while (cursor);
  return ids;
}

module.exports = { syncChannel };
