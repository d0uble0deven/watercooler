'use strict';

// Channel-based auto-enrollment event handlers.
//
// When enrollment_mode is 'channel', joining the intro channel enrolls a user
// and leaving opts them out. Both handlers share the same guard: the feature
// must be on, the event must be for the configured intro channel, and the
// event must not be about the bot's own membership.
//
// Registered in app.js:
//   app.event('member_joined_channel', handleMemberJoinedChannel)
//   app.event('member_left_channel',   handleMemberLeftChannel)

const { getSettings } = require('../../lib/rounds');
const { enrollUser, unenrollUser } = require('../../lib/enrollment');

async function handleMemberJoinedChannel({ event, client, context }) {
  if (!shouldHandle(event, context)) return;
  try {
    const status = await enrollUser(client, event.user, 'channel');
    console.log(`[channelEnroll] ${event.user} joined ${event.channel} → ${status}`);
  } catch (err) {
    console.error(`[channelEnroll] enroll failed for ${event.user}:`, err.message);
  }
}

async function handleMemberLeftChannel({ event, context }) {
  if (!shouldHandle(event, context)) return;
  try {
    const status = unenrollUser(event.user);
    console.log(`[channelEnroll] ${event.user} left ${event.channel} → ${status}`);
  } catch (err) {
    console.error(`[channelEnroll] unenroll failed for ${event.user}:`, err.message);
  }
}

// Shared guard for both events.
function shouldHandle(event, context) {
  const settings = getSettings();
  if (settings.enrollment_mode !== 'channel') return false;        // feature off
  if (event.channel !== settings.intro_channel_id) return false;   // some other channel
  if (event.user === context?.botUserId) return false;             // the bot itself
  return true;
}

module.exports = { handleMemberJoinedChannel, handleMemberLeftChannel, shouldHandle };
