'use strict';

// Handles: /watercooler reschedule
//
// Finds the caller's soonest upcoming booked Watercooler meeting and kicks off
// the same reschedule flow as the 🔄 button on the booking confirmation —
// without requiring them to scroll back through the DM to find it.
//
// Reuses checkRescheduleEligibility() / performReschedule() from the button
// handler (src/commands/actions/reschedule.js) so both entry points share
// identical guard logic and behavior.

const { getUpcomingBookedMatchForUser, getMatchUsers, getSettings } = require('../../lib/rounds');
const { formatNameList } = require('../../slack/messaging');
const { formatSlotLabel } = require('../../integrations/calendarScheduler');
const { checkRescheduleEligibility, performReschedule } = require('../actions/reschedule');

async function reschedule(command, respond, client) {
  const match = getUpcomingBookedMatchForUser(command.user_id);

  if (!match) {
    await respond(
      "You don't have an upcoming Watercooler meeting to reschedule right now.\n" +
      'Check `/watercooler status` to see where things stand.'
    );
    return;
  }

  // match came straight from the DB, so 'not_found' can't happen here —
  // only 'pending' / 'already_rescheduling' / 'ok' are reachable.
  const check = checkRescheduleEligibility(match.id);

  if (check.status === 'pending') {
    await respond('⏳ A booking is just being confirmed — please wait a moment, then try again.');
    return;
  }
  if (check.status === 'already_rescheduling') {
    await respond('⏳ New time options were already posted in your group DM — scroll up there to pick a slot.');
    return;
  }

  await respond(buildFoundMessage(command.user_id, match));
  await performReschedule(client, match);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFoundMessage(callerId, match) {
  const users  = getMatchUsers(match.id);
  const others = users.filter((u) => u.slack_user_id !== callerId);
  const names  = formatNameList(others.map((u) => u.display_name)) || 'your match';

  const tz   = getSettings()?.calendar_timezone || 'America/New_York';
  const when = match.meeting_start_at && match.meeting_end_at
    ? formatSlotLabel({ start: new Date(match.meeting_start_at), end: new Date(match.meeting_end_at) }, tz)
    : null;

  const whenText = when ? ` (${when})` : '';
  return `🔄 Found your upcoming meeting with *${names}*${whenText} — posting fresh time options in your group DM now!`;
}

module.exports = reschedule;
