'use strict';

// Creates a Microsoft 365 calendar event with a Teams meeting link for a
// Watercooler match group.
//
// Uses app-only auth via the Graph client from msGraph.js.
// Required Azure AD permissions (granted by IT):
//   • Calendars.ReadWrite  — create events on behalf of any user in the tenant
//   • OnlineMeetings.ReadWrite — generate the Teams join URL
//
// The event is created on behalf of the first participant (organizer). All
// participants are added as required attendees and will receive email invites
// from Microsoft's calendar system.

const { formatSlotLabel }  = require('./calendarScheduler');
const { formatNameList }   = require('../slack/messaging');
const { toGraphDateTime }  = require('./calendarReader');

// ── Booking ───────────────────────────────────────────────────────────────────

/**
 * Creates a calendar event with a Teams meeting link for a match group.
 *
 * @param {object}   graphClient   MS Graph client from getGraphClient()
 * @param {object[]} users         DB user rows — must each have .slack_email and .display_name
 * @param {Date}     slotStart     Meeting start time (UTC)
 * @param {Date}     slotEnd       Meeting end time (UTC)
 *
 * @returns {Promise<{ eventId: string, teamsLink: string|null, start: Date, end: Date }>}
 * @throws  on Graph API failure — caller is responsible for catching
 */
async function bookMeeting(graphClient, users, slotStart, slotEnd) {
  const organizer = users[0];
  const names     = users.map((u) => u.display_name);

  const subject = names.length === 2
    ? `Watercooler: ${names[0]} & ${names[1]}`
    : `Watercooler: ${names.join(', ')}`;

  const attendees = users.map((u) => ({
    emailAddress: { address: u.slack_email, name: u.display_name },
    type: 'required',
  }));

  const eventPayload = {
    subject,
    body: {
      contentType: 'HTML',
      content:     buildEventBodyHtml(users),
    },
    start: { dateTime: toGraphDateTime(slotStart), timeZone: 'UTC' },
    end:   { dateTime: toGraphDateTime(slotEnd),   timeZone: 'UTC' },
    attendees,
    isOnlineMeeting:       true,
    onlineMeetingProvider: 'teamsForBusiness',
  };

  const event = await graphClient
    .api(`/users/${encodeURIComponent(organizer.slack_email)}/events`)
    .post(eventPayload);

  return {
    eventId:   event.id,
    teamsLink: event.onlineMeeting?.joinUrl ?? null,
    start:     slotStart,
    end:       slotEnd,
  };
}

// ── Slack message builders ────────────────────────────────────────────────────

/**
 * Builds the Block Kit blocks that replace the time-selection buttons after
 * a meeting is successfully booked.
 *
 * @param {{ start: Date, end: Date, teamsLink: string|null }} booking
 * @param {object[]} users         Match participants
 * @param {string}   timezoneId    IANA timezone for display (e.g. 'America/New_York')
 * @returns {object[]}             Slack blocks array
 */
function buildConfirmationMessage(booking, users, timezoneId = 'UTC') {
  const timeLabel = formatSlotLabel({ start: booking.start, end: booking.end }, timezoneId);
  const nameList  = formatNameList(users.map((u) => u.display_name));

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `✅ *Meeting booked!*\n\n📅 ${timeLabel}\n👥 ${nameList}`,
      },
    },
  ];

  if (booking.teamsLink) {
    blocks.push({
      type:     'actions',
      elements: [{
        type:      'button',
        text:      { type: 'plain_text', text: '🎥 Join Teams Meeting', emoji: true },
        url:       booking.teamsLink,
        action_id: 'watercooler_join_teams',
        style:     'primary',
      }],
    });
  }

  blocks.push({
    type:     'context',
    elements: [{
      type: 'mrkdwn',
      text: '_A calendar invite has been sent to everyone. See you there! ☕_',
    }],
  });

  return blocks;
}

/**
 * Builds the plain-text blocks shown when a meeting was already booked by
 * someone else in the group (race-condition guard).
 */
function buildAlreadyBookedMessage(teamsLink) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '✅ *This meeting has already been booked!* Check your calendar for the invite.',
      },
    },
  ];

  if (teamsLink) {
    blocks.push({
      type:     'actions',
      elements: [{
        type:      'button',
        text:      { type: 'plain_text', text: '🎥 Join Teams Meeting', emoji: true },
        url:       teamsLink,
        action_id: 'watercooler_join_teams',
      }],
    });
  }

  return blocks;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds the HTML body for the calendar invite email that attendees receive.
 */
function buildEventBodyHtml(users) {
  const names = formatNameList(users.map((u) => u.display_name));
  return [
    '<p>This meeting was arranged by <strong>Watercooler</strong>,',
    ' DocMe360\'s internal social matching program.</p>',
    `<p>You\'re meeting with: <strong>${names}</strong></p>`,
    '<p>Have a great chat! ☕</p>',
  ].join('');
}

module.exports = {
  bookMeeting,
  buildConfirmationMessage,
  buildAlreadyBookedMessage,
  buildEventBodyHtml,
};
