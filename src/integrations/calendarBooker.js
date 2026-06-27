"use strict";

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

const config = require("../config");
const { formatSlotLabel } = require("./calendarScheduler");
const { formatNameList } = require("../slack/messaging");
const { toGraphDateTime } = require("./calendarReader");
const { withRetry } = require("../lib/retryHelper");

// ── Booking ───────────────────────────────────────────────────────────────────

/**
 * Creates a calendar event with a Teams meeting link for a match group.
 *
 * @param {object}   graphClient   MS Graph client from getGraphClient()
 * @param {object[]} users         DB user rows — must each have .slack_email and .display_name
 * @param {Date}     slotStart     Meeting start time (UTC)
 * @param {Date}     slotEnd       Meeting end time (UTC)
 * @param {string}   [funFact]     Conversation-starter fact for the invite email
 *
 * @returns {Promise<{ eventId: string, teamsLink: string|null, start: Date, end: Date }>}
 * @throws  on Graph API failure — caller is responsible for catching
 */
async function bookMeeting(
  graphClient,
  users,
  slotStart,
  slotEnd,
  funFact = null,
) {
  const organizer = users[0];
  const names = users.map((u) => u.display_name);

  const subject =
    names.length === 2
      ? `Watercooler: ${names[0]} & ${names[1]}`
      : `Watercooler: ${names.join(", ")}`;

  const attendees = users.map((u) => ({
    emailAddress: { address: u.slack_email, name: u.display_name },
    type: "required",
  }));

  const eventPayload = {
    subject,
    body: {
      contentType: "HTML",
      content: buildEventBodyHtml(users, funFact),
    },
    start: { dateTime: toGraphDateTime(slotStart), timeZone: "UTC" },
    end: { dateTime: toGraphDateTime(slotEnd), timeZone: "UTC" },
    attendees,
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
  };

  const event = await withRetry(() =>
    graphClient
      .api(`/users/${encodeURIComponent(organizer.slack_email)}/events`)
      .post(eventPayload),
  );

  return {
    eventId: event.id,
    teamsLink: event.onlineMeeting?.joinUrl ?? null,
    start: slotStart,
    end: slotEnd,
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
function buildConfirmationMessage(
  booking,
  users,
  timezoneId = "UTC",
  matchId = null,
) {
  const timeLabel = formatSlotLabel(
    { start: booking.start, end: booking.end },
    timezoneId,
  );
  const nameList = formatNameList(users.map((u) => u.display_name));

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `✅ *Meeting booked!*\n\n📅 ${timeLabel}\n👥 ${nameList}`,
      },
    },
  ];

  const actionElements = [];

  if (booking.teamsLink) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "🎥 Join Teams Meeting", emoji: true },
      url: booking.teamsLink,
      action_id: "watercooler_join_teams",
      style: "primary",
    });
  }

  if (matchId != null) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "🔄 Reschedule", emoji: true },
      value: String(matchId),
      action_id: "watercooler_reschedule",
    });
  }

  if (actionElements.length > 0) {
    blocks.push({ type: "actions", elements: actionElements });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "_A calendar invite has been sent to everyone. See you there! ☕_",
      },
    ],
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
      type: "section",
      text: {
        type: "mrkdwn",
        text: "✅ *This meeting has already been booked!* Check your calendar for the invite.",
      },
    },
  ];

  if (teamsLink) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "🎥 Join Teams Meeting",
            emoji: true,
          },
          url: teamsLink,
          action_id: "watercooler_join_teams",
        },
      ],
    });
  }

  return blocks;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds the HTML body for the calendar invite email that attendees receive.
 * Appears above the Teams meeting details that Outlook appends automatically.
 */
function buildEventBodyHtml(users, funFact = null) {
  const names = formatNameList(users.map((u) => u.display_name));
  const contactLine = config.contactName
    ? `<p>Questions, suggestions, or something broken? ` +
      `Reach out to <strong>${config.contactName}</strong> on Slack.</p>`
    : "";

  const funFactLine = funFact
    ? `<p>☕ <strong>Conversation starter:</strong> ${escapeHtml(funFact)}</p>`
    : "";

  return [
    "<p>Hi there! 👋</p>",
    "<p>This meeting was set up by <strong>Watercooler</strong> — DocMe360's internal program ",
    "for building connections across the team. Every few weeks, Watercooler pairs team members ",
    "for a casual 15-minute virtual coffee, so you get to know people outside your usual Slack channels.</p>",
    `<p>You\'re meeting with: <strong>${names}</strong></p>`,
    "<p>Your booking confirmation and the original intro message are in your Slack group DM ",
    "with your match partner — feel free to coordinate there if you need to reschedule.</p>",
    "<p>Have a great chat! ☕</p>",
    "<p>— The Watercooler bot</p>",
    "<hr>",
    contactLine,
    funFactLine,
    "<p><em>(Microsoft Teams meeting details below)</em></p>",
  ].join("");
}

// Minimal HTML-escape for the fact text (facts are our own content, but this
// keeps any stray <, >, & from breaking the invite markup).
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = {
  bookMeeting,
  buildConfirmationMessage,
  buildAlreadyBookedMessage,
  buildEventBodyHtml,
};
