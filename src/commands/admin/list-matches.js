'use strict';

// Handles: /watercooler admin list-matches [roundId | last <n>]
//
//   list-matches          → last 2 rounds (default)
//   list-matches 8        → all matches in round 8, any age or status
//   list-matches last 5   → last 5 rounds (max 10)
//
// Shows every match ID, participant names, and current workflow state.
// Gives admins the match IDs needed for force-book, send-completion,
// resend-suggestions, and cancel-round.

const { getRecentMatchesForAdmin, getRoundMatchesForAdmin, getSettings } = require('../../lib/rounds');

const MAX_ROUNDS = 10;

const USAGE =
  '❌ Usage: `list-matches` (last 2 rounds), `list-matches <roundId>`, or `list-matches last <n>`';

async function listMatches(command, args, respond) {
  const input = (args || '').trim();

  let result;
  let header;

  if (!input) {
    // Default: last 2 rounds
    result = getRecentMatchesForAdmin(2);
    header = `*Recent matches (last ${result.rounds.length} round(s)):*`;

    if (result.rounds.length === 0) {
      await respond('No rounds found yet. Run `/watercooler admin run` to kick off the first round.');
      return;
    }
  } else if (/^\d+$/.test(input)) {
    // Specific round by ID (historic lookup)
    const roundId = parseInt(input, 10);
    result = getRoundMatchesForAdmin(roundId);

    if (result.rounds.length === 0) {
      await respond(`❌ Round #${roundId} not found. Use \`list-matches last 10\` to see recent round IDs.`);
      return;
    }
    header = `*Matches for round #${roundId}:*`;
  } else {
    // "last <n>" form
    const lastMatch = input.match(/^last\s+(\d+)$/i);
    if (!lastMatch) {
      await respond(USAGE);
      return;
    }

    const n = parseInt(lastMatch[1], 10);
    if (n < 1 || n > MAX_ROUNDS) {
      await respond(`❌ \`last <n>\` must be between 1 and ${MAX_ROUNDS} rounds.`);
      return;
    }

    result = getRecentMatchesForAdmin(n);
    if (result.rounds.length === 0) {
      await respond('No rounds found yet. Run `/watercooler admin run` to kick off the first round.');
      return;
    }
    header = `*Recent matches (last ${result.rounds.length} round(s)):*`;
  }

  const { rounds, matches } = result;
  const settings = getSettings();
  const tz       = settings?.calendar_timezone ?? 'America/New_York';
  const lines    = [`${header}\n`];

  for (const round of rounds) {
    const roundMatches = matches.filter((m) => m.round_id === round.id);
    const dateStr      = formatDate(round.started_at, tz);
    lines.push(`*Round ${round.id}* — ${dateStr} · _${round.status}_`);

    if (roundMatches.length === 0) {
      lines.push('  _No matches in this round_');
    } else {
      for (const m of roundMatches) {
        const state = matchState(m, tz);
        const names = m.participants ?? '_(unknown)_';
        lines.push(`  \`#${m.id}\` · ${names} · ${state}`);
      }
    }
    lines.push('');
  }

  lines.push('_Use match IDs with: `force-book`, `send-completion`, `resend-suggestions`, `cancel-round`_');

  await respond(lines.join('\n').trim());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchState(m, tz) {
  if (m.completion_message_sent) return '✅ Completed';

  if (m.calendar_event_id) {
    const when = m.meeting_start_at ? ` · ${formatDate(m.meeting_start_at, tz)}` : '';
    return `📅 Booked${when}`;
  }

  if (m.calendar_suggestion_ts) return '⏳ Awaiting slot choice';
  if (m.slack_dm_channel_id)    return '📨 Intro sent';
  return '⚠️ No DM channel';
}

function formatDate(isoString, tz) {
  if (!isoString) return 'unknown date';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month:    'short',
    day:      'numeric',
    year:     'numeric',
  }).format(new Date(isoString));
}

module.exports = { listMatches };
