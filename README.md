# Watercooler

Internal Slack app for casual 1:1 social matching — similar to Donut, self-hosted and fully customisable.

---

## Documentation

| Document | What it covers |
|---|---|
| [docs/GO_LIVE.md](docs/GO_LIVE.md) | Launch runbook — final end-to-end test in a test channel, then go live |
| [docs/USER_MANUAL.md](docs/USER_MANUAL.md) | End-user and admin guide — all Slack commands explained |
| [docs/SLACK_CONCEPTS.md](docs/SLACK_CONCEPTS.md) | Plain-English guide to every Slack concept used in this app |
| [docs/PRODUCTION.md](docs/PRODUCTION.md) | Step-by-step deployment guide — Slack setup, scopes, hosting, monitoring |
| [docs/DONUT_COMPARISON.md](docs/DONUT_COMPARISON.md) | Feature comparison vs. Donut, and a prioritised list of future additions |
| [docs/OUTLOOK_INTEGRATION.md](docs/OUTLOOK_INTEGRATION.md) | Outlook calendar + Teams auto-booking setup guide (IT + developer steps) |
| [docs/CHANNEL_ENROLLMENT_PLAN.md](docs/CHANNEL_ENROLLMENT_PLAN.md) | Channel-based auto-enrollment — design record + Slack app config steps (implemented) |
| [docs/AZURE_DEPLOYMENT.md](docs/AZURE_DEPLOYMENT.md) | Hosting the app on Azure — VM setup, database migration, and keeping it running |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contributor guide — setup, tests, conventions, PR workflow |
| [docs/REPO_MIGRATION.md](docs/REPO_MIGRATION.md) | Plan for moving the repo to the org GitHub + how prod deploys relate to it |

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create your .env (never commit this)
cp .env.example .env

# 3. Start the server (works without Slack credentials for local dev)
npm start

# OR: watch mode — auto-restarts on file changes
npm run dev
```

The server starts on `http://localhost:3000`. Verify it's running:

```bash
curl http://localhost:3000/health
# → { "status": "ok", "slack_connected": false, "timestamp": "..." }
```

---

## Connecting to Slack

See [docs/PRODUCTION.md](docs/PRODUCTION.md) for the full step-by-step guide, including which scopes to add and how to find your credentials.

Short version:
1. Create a Slack app at https://api.slack.com/apps
2. Enable Socket Mode → generate an App-Level Token (`xapp-...`)
3. Add bot scopes: `commands`, `chat:write`, `im:write`, `mpim:write`, `users:read`, `users:read.email`, `channels:read` (last one only needed for channel-based enrollment)
   - For channel-based enrollment also subscribe to bot events `member_joined_channel` and `member_left_channel` (Event Subscriptions — works over Socket Mode, no Request URL)
4. Install to workspace → copy Bot Token (`xoxb-...`)
5. Copy Signing Secret from Basic Information
6. Fill in `.env` with all three tokens + `ADMIN_USER_IDS`
7. Restart — you'll see `⚡️ Slack Bolt connected via Socket Mode`

---

## Commands

### User commands — available to everyone

| Command | Description |
|---|---|
| `/watercooler join` | Opt in to matching |
| `/watercooler pause` | Sit out of matching temporarily (stays opted in) |
| `/watercooler resume` | Come back after pausing |
| `/watercooler leave` | Opt out entirely |
| `/watercooler status` | Check your current participation status |
| `/watercooler reschedule` | Pick a new time for your upcoming meeting (finds it for you — no need to scroll back to the confirmation message) |

### Admin commands — restricted to `ADMIN_USER_IDS`

#### Running rounds

| Command | Description |
|---|---|
| `/watercooler admin dry-run` | Preview matches without sending any DMs |
| `/watercooler admin test-run` | Full run with a 🧪 test disclaimer on all messages |
| `/watercooler admin run` | Trigger a matching round and send intro DMs |

#### Monitoring

| Command | Description |
|---|---|
| `/watercooler admin summary` | Participant counts at a glance |
| `/watercooler admin participants` | List everyone eligible for the next round |
| `/watercooler admin paused` | List everyone currently paused |
| `/watercooler admin settings` | Show current app settings |
| `/watercooler admin recent-rounds` | Show the last few completed rounds |

#### Configuration

| Command | Description |
|---|---|
| `/watercooler admin set group-size <n>` | Set pair/group size (must be ≥ 2) |
| `/watercooler admin set cadence weekly\|biweekly\|triweekly\|monthly` | Set matching frequency |
| `/watercooler admin set avoid-repeat-rounds <n>` | Repeat-avoidance window (0 = off) |
| `/watercooler admin set channel <channel-id>` | Channel for announcements + channel-based enrollment |
| `/watercooler admin set enrollment manual\|channel` | How people join: slash command only, or joining the intro channel |
| `/watercooler admin exclude @user` | Prevent a user from being matched |
| `/watercooler admin include @user` | Lift an exclusion |
| `/watercooler admin refresh-names` | Re-fetch display names from Slack profiles |
| `/watercooler admin calendar-status` | Check Microsoft Graph connection |
| `/watercooler admin sync-channel` | Backfill: enroll everyone already in the intro channel (channel mode) |

#### Workflow recovery

| Command | Description |
|---|---|
| `/watercooler admin list-matches [roundId \| last <n>]` | Show match IDs, participants, and workflow state (default: last 2 rounds, max 10) |
| `/watercooler admin force-book [matchId]` | Auto-book one match or all unbooked matches now |
| `/watercooler admin send-completion [matchId]` | Send post-meeting message to one or all qualifying matches |
| `/watercooler admin resend-suggestions <matchId>` | Re-post calendar slot buttons for a match |
| `/watercooler admin cancel-round [roundId]` | Cancel a round and notify all affected DMs |

---

## npm Scripts

| Script | What it does |
|---|---|
| `npm start` | Start the app |
| `npm run dev` | Start with file watching (auto-restart) |
| `npm run db:init` | Create tables and run migrations (safe to re-run) |
| `npm run db:reset` | Drop and recreate all tables (dev only) |
| `npm test` | Matching engine unit tests (node:test) |
| `npm run test:commands` | User command smoke tests |
| `npm run test:dry-run` | Dry-run smoke test |
| `npm run test:run` | Run smoke test (mock Slack client) |
| `npm run test:admin` | Admin command smoke tests |
| `npm run test:scheduler` | Scheduler logic tests |
| `npm run test:cal-connection` | Microsoft Graph connection test |
| `npm run test:cal-settings` | Calendar settings tests |
| `npm run test:cal-freebusy` | Free/busy query tests |
| `npm run test:cal-slot-logic` | Slot finder logic tests |
| `npm run test:cal-email-resolve` | Email resolution tests |
| `npm run test:cal-book-slot` | Slot booking tests |
| `npm run test:cal-create-event` | Calendar event creation tests |
| `npm run test:cal-tz-display` | Timezone display tests |
| `npm run test:meeting-completion` | Post-meeting completion tests |
| `npm run test:meeting-feedback` | Feedback message tests |
| `npm run test:round-stats` | Round statistics tests |
| `npm run test:completion-message` | Completion message builder tests |
| `npm run test:fallback-days` | Fallback deadline tests |
| `npm run test:slot-distribution` | Slot distribution tests (34 tests) |
| `npm run test:tz-intersection` | Timezone intersection tests (47 tests) |
| `npm run test:admin-commands` | Admin workflow command tests (40 tests) |
| `npm run test:reschedule` | Reschedule flow tests (21 tests) |
| `npm run test:reschedule-variety` | Reschedule slot variety + `/watercooler reschedule` command tests (27 tests) |
| `npm run test:enrollment` | Channel-enrollment tests (38 tests) |
| `npm run test:all` | Run all test suites in sequence |

---

## Project Structure

```
src/
  app.js              — entry point: Express + Slack Bolt bootstrap, graceful shutdown
  config.js           — reads all environment variables
  commands/
    index.js          — registers /watercooler with Bolt, routes subcommands
    user/             — join, pause, resume, leave, status, reschedule
    admin/            — index (router + admin guard), dry-run, test-run, run,
                        summary, participants, paused, show-settings, recent-rounds,
                        set, exclusions, calendar-status, refresh-names,
                        list-matches, force-book, send-completion,
                        resend-suggestions, cancel-round, sync-channel
    actions/          — bookSlot (slot button handler), meetingFeedback,
                        reschedule (reschedule button handler)
    events/           — channelMembership (member_joined/left_channel handlers)
  integrations/
    msGraph.js        — Microsoft Graph client (app-only auth via Azure AD)
    calendarReader.js — free/busy queries via Graph API
    calendarScheduler.js — slot suggestion orchestration, timezone intersection
    calendarBooker.js — calendar event creation, confirmation message builder
    calendarAutoBooker.js — automatic booking when deadline passes
    meetingCompleter.js — post-meeting follow-up and round-complete channel summary
    declineWatcher.js   — polls Graph for declined invites, posts reschedule nudge
  matching/
    engine.js         — pure matching algorithm (Fisher-Yates + greedy repeat-avoidance)
  scheduler/
    index.js          — minute-tick scheduler, cadence guard, day/time helpers
  slack/
    messaging.js      — conversations.open, chat.postMessage, intro message builder
  db/
    connection.js     — node:sqlite singleton
    init.js           — CREATE TABLE IF NOT EXISTS + ALTER TABLE migrations
  lib/
    users.js          — user + exclusion DB helpers, email + timezone cache
    enrollment.js     — shared enroll/unenroll logic + welcome DM (channel enrollment)
    rounds.js         — round, match, booking, pair history, settings DB helpers
    slotFinder.js     — free-slot algorithm with prime-hours preference
    retryHelper.js    — exponential backoff wrapper for Graph API calls
    adminGuard.js     — isAdmin() check
docs/
  USER_MANUAL.md      — end-user and admin Slack command reference
  SLACK_CONCEPTS.md   — Slack app concepts reference
  PRODUCTION.md       — deployment guide
  DONUT_COMPARISON.md — feature comparison vs. Donut
  OUTLOOK_INTEGRATION.md — Azure AD + calendar setup guide
  AZURE_DEPLOYMENT.md — Azure VM hosting guide
scripts/
  db-init.js          — run db init standalone
  db-reset.js         — wipe and recreate (dev only)
  test-commands.js    — user command smoke tests
  test-dry-run.js     — dry-run smoke test
  test-run.js         — run smoke test (mock Slack client)
  test-admin.js       — admin command smoke tests
  test-scheduler.js   — scheduler logic tests
  test-calendar-*.js  — calendar integration tests (connection through tz display)
  test-post-meeting-*.js — post-meeting flow tests
  test-slot-distribution.js  — slot distribution algorithm tests
  test-slot-finder.js        — slot finder unit tests
  test-timezone-intersection.js — multi-timezone overlap tests
  test-admin-commands.js     — workflow recovery command tests
  test-reschedule.js         — reschedule flow tests
tests/
  matching.test.js    — matching engine unit tests (node:test)
```

---

## Environment Variables

See [`.env.example`](.env.example) for the full list.

```env
# Slack (required)
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...
ADMIN_USER_IDS=U01ABC123,U02DEF456

# Server
PORT=3000
DATABASE_PATH=./data/watercooler.db
SCHEDULING_ENABLED=true        # false in local dev

# Calendar / Microsoft 365 (optional — enables slot suggestions + auto-booking)
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
CALENDAR_ENABLED=true
CALENDAR_TIMEZONE=America/New_York

# Branding (optional — appears in calendar invite emails)
CONTACT_NAME=Your Name
```

---

## Build Phases

- [x] Phase 0 — Discovery + Slack concepts
- [x] Phase 1 — Basic app skeleton (Express, health endpoint)
- [x] Phase 2 — SQLite persistence (schema, db:init, db:reset)
- [x] Phase 3 — User participation commands (join, pause, resume, leave, status)
- [x] Phase 4 — Matching engine (Fisher-Yates, greedy repeat-avoidance)
- [x] Phase 5 — Admin dry run
- [x] Phase 6 — Admin real run (Slack DMs, pair history, partial-failure tolerance)
- [x] Phase 7 — Admin management commands (summary, participants, set, exclude/include, etc.)
- [x] Phase 8 — Scheduled automation (minute-tick scheduler, cadence guard)
- [x] Phase 9 — Production hardening (crash recovery, graceful shutdown, deployment guide)
- [x] Phase 10 — Outlook/Teams calendar integration (free/busy queries, slot suggestions, auto-booking, Teams links)
- [x] Phase 11 — Post-meeting follow-up (completion detection, feedback buttons, round-complete channel summary)
- [x] Timezone awareness — per-user M365 timezones, shared-window intersection, DST-correct display
- [x] Admin workflow commands — list-matches, force-book, send-completion, resend-suggestions, cancel-round
- [x] Reschedule flow — user-initiated reschedule button; deferred old-event deletion after new slot confirmed
- [x] Reschedule variety + self-serve command — up to 9 slots spanning "later today" through next week (vs. 3 for the initial round suggestion); `/watercooler reschedule` finds your upcoming meeting without needing the original button
