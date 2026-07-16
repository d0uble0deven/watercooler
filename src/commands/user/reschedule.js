'use strict';

// Handles: /watercooler reschedule
//
// Finds the caller's current Watercooler match — booked or not — and posts a
// fresh set of time options, without requiring them to dig the original buttons
// out of DM history.
//
// Works for the whole life of a round:
//   • Already booked        → old event kept until a new time is picked
//   • Never picked a time   → just posts fresh options (nothing to reset)
//   • Meeting time passed but round not closed → still reschedulable
//
// Privacy: options are posted ephemerally (only the caller sees them). The
// match partner isn't notified until a new time is actually booked. See the
// header of src/commands/actions/reschedule.js for the full privacy model.

const { getReschedulableMatchForUser, getMatchUsers, getSettings } = require('../../lib/rounds');
const { formatNameList } = require('../../slack/messaging');
const { formatSlotLabel } = require('../../integrations/calendarScheduler');
const { checkRescheduleEligibility, performReschedule } = require('../actions/reschedule');

async function reschedule(command, respond, client) {
  const match = getReschedulableMatchForUser(command.user_id);

  if (!match) {
    await respond(
      "You don't have a Watercooler match to reschedule right now.\n" +
      'Check `/watercooler status` to see where things stand.'
    );
    return;
  }

  // match came straight from the DB, so 'not_found' can't happen here.
  const check = checkRescheduleEligibility(match.id);

  if (check.status === 'pending') {
    await respond('⏳ A booking is just being confirmed — please wait a moment, then try again.');
    return;
  }

  // 'ok' (booked or never-booked) and 'already_rescheduling' both proceed —
  // performReschedule skips the reset when there's nothing booked to clear.
  await respond(buildFoundMessage(command.user_id, match));
  await performReschedule(client, match, command.user_id);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFoundMessage(callerId, match) {
  const users  = getMatchUsers(match.id);
  const others = users.filter((u) => u.slack_user_id !== callerId);
  const names  = formatNameList(others.map((u) => u.display_name)) || 'your match';

  // Only booked matches have a meeting time to reference.
  if (!match.meeting_start_at || !match.meeting_end_at) {
    return `🔄 Found your match with *${names}* — posting time options in your group DM now. _Only you will see them._`;
  }

  const tz   = getSettings()?.calendar_timezone || 'America/New_York';
  const when = formatSlotLabel(
    { start: new Date(match.meeting_start_at), end: new Date(match.meeting_end_at) },
    tz,
  );

  return (
    `🔄 Found your meeting with *${names}* (${when}) — posting fresh time options in your group DM now.\n` +
    '_Only you will see them. Your match will be notified once you book a new time._'
  );
}

module.exports = reschedule;
