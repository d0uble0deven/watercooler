'use strict';

// Handles: /watercooler admin calendar-status
//
// Verifies the Microsoft Graph connection without enabling or changing anything.
// Safe to run at any time — read-only, no side effects.
//
// Three possible outcomes:
//   1. Credentials missing  → tells admin what to add to .env
//   2. Credentials present but auth fails → points to likely cause (admin consent)
//   3. Connected successfully → confirms ready, shows current CALENDAR_ENABLED state

const { getGraphClient, hasAzureCredentials } = require('../../integrations/msGraph');
const config = require('../../config');

async function calendarStatus(command, respond) {

  // ── 1. Credentials not configured ──────────────────────────────────────────
  if (!hasAzureCredentials()) {
    await respond([
      '⚠️ *Microsoft Graph is not configured.*',
      '',
      'The following values are missing from `.env`:',
      '• `AZURE_TENANT_ID`',
      '• `AZURE_CLIENT_ID`',
      '• `AZURE_CLIENT_SECRET`',
      '',
      'Ask your Microsoft IT admin to follow the setup steps in `docs/OUTLOOK_INTEGRATION.md`.',
      'They\'ll send you the three values to add to `.env`. Restart the server once they\'re in.',
    ].join('\n'));
    return;
  }

  // ── 2. Credentials present — test the connection ────────────────────────────
  const client = getGraphClient();

  try {
    // Lightweight call — just fetches the org display name to confirm auth works.
    await client.api('/organization').select('displayName').get();

    // ── 3. Connected ────────────────────────────────────────────────────────────
    const enabledLine = config.calendarEnabled
      ? '`CALENDAR_ENABLED` is *true* — calendar integration is active.'
      : '`CALENDAR_ENABLED` is *false* — integration is ready but not yet active.\nRun `/watercooler admin set calendar-enabled true` to turn it on.';

    await respond([
      '✅ *Microsoft Graph connected — calendar integration is ready.*',
      '',
      enabledLine,
    ].join('\n'));

  } catch (err) {
    // ── Auth failed ─────────────────────────────────────────────────────────────
    const hint = err.message?.toLowerCase().includes('unauthorized') || err.statusCode === 401
      ? 'This usually means IT hasn\'t clicked "Grant admin consent" in the Azure portal yet.\nAsk them to check Step 3 in `docs/OUTLOOK_INTEGRATION.md`.'
      : 'Check that `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET` in `.env` are correct.';

    await respond([
      '❌ *Microsoft Graph authentication failed.*',
      '',
      hint,
      '',
      `_Error: ${err.message}_`,
    ].join('\n'));
  }
}

module.exports = calendarStatus;
