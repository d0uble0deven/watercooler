'use strict';

// Handles: /watercooler admin list-matches
//
// Shows the last 2 rounds with every match ID, participant names, and
// current workflow state. Gives admins the match IDs needed for
// force-book, send-completion, resend-suggestions, and cancel-round.

const { getRecentMatchesForAdmin, getSettings } = require('../../lib/rounds');

async function listMatches(command, respond) {
  const { rounds, matches } = getRecentMatchesForAdmin(2);

  if (rounds.length === 0) {
    await respond('No rounds found yet. Run `/watercooler admin run` to kick off the first round.');
    return;
  }

  const settings = getSettings();
  const tz       = settings?.calendar_timezone ?? 'America/New_York';
  const lines    = ['*Recent matches (last 2 rounds):*\n'];

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
