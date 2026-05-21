# Watercooler

Internal Slack app for casual 1:1 social matching — similar to Donut, self-hosted and fully customisable.

---

## Documentation

| Document | What it covers |
|---|---|
| [docs/SLACK_CONCEPTS.md](docs/SLACK_CONCEPTS.md) | Plain-English guide to every Slack concept used in this app |
| [docs/PRODUCTION.md](docs/PRODUCTION.md) | Step-by-step deployment guide — Slack setup, scopes, hosting, monitoring |
| [docs/DONUT_COMPARISON.md](docs/DONUT_COMPARISON.md) | Feature comparison vs. Donut, and a prioritised list of future additions |
| [docs/OUTLOOK_INTEGRATION.md](docs/OUTLOOK_INTEGRATION.md) | Outlook calendar + Teams auto-booking setup guide (IT + developer steps) |

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
3. Add bot scopes: `commands`, `chat:write`, `im:write`, `mpim:write`
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

### Admin commands — restricted to `ADMIN_USER_IDS`

| Command | Description |
|---|---|
| `/watercooler admin dry-run` | Preview matches without sending any DMs |
| `/watercooler admin run` | Trigger a matching round and send intro DMs |
| `/watercooler admin summary` | Participant counts at a glance |
| `/watercooler admin participants` | List everyone eligible for the next round |
| `/watercooler admin paused` | List everyone currently paused |
| `/watercooler admin settings` | Show current app settings |
| `/watercooler admin recent-rounds` | Show the last 5 completed rounds |
| `/watercooler admin set group-size <n>` | Set pair/group size (must be ≥ 2) |
| `/watercooler admin set cadence weekly\|biweekly\|monthly` | Set matching frequency |
| `/watercooler admin set intro-day <day>` | Set which day of the week the scheduler fires |
| `/watercooler admin set intro-time <HH:MM>` | Set what time the scheduler fires (24-hour) |
| `/watercooler admin set avoid-repeat-rounds <n>` | Repeat-avoidance window (0 = off) |
| `/watercooler admin set channel <channel-id>` | Channel for round announcements |
| `/watercooler admin exclude @user` | Prevent a user from being matched |
| `/watercooler admin include @user` | Lift an exclusion |

---

## npm Scripts

| Script | What it does |
|---|---|
| `npm start` | Start the app |
| `npm run dev` | Start with file watching (auto-restart) |
| `npm run db:init` | Create tables (safe to re-run) |
| `npm run db:reset` | Drop and recreate all tables (dev only) |
| `npm test` | Run matching engine unit tests (35 tests) |
| `npm run test:commands` | Smoke test user commands |
| `npm run test:dry-run` | Smoke test dry-run |
| `npm run test:admin` | Smoke test all admin commands (38 tests) |
| `npm run test:scheduler` | Smoke test scheduler logic (41 tests) |
| `npm run test:all` | Run all test suites in sequence |

---

## Project Structure

```
src/
  app.js              — entry point: Express + Slack Bolt bootstrap, graceful shutdown
  config.js           — reads all environment variables
  commands/
    index.js          — registers /watercooler with Bolt, routes subcommands
    user/             — join, pause, resume, leave, status
    admin/            — index (router + admin guard), dry-run, run, summary,
                        participants, paused, show-settings, recent-rounds,
                        set, exclusions
  matching/
    engine.js         — pure matching algorithm (Fisher-Yates + greedy repeat-avoidance)
  scheduler/
    index.js          — minute-tick scheduler, cadence guard, day/time helpers
  slack/
    messaging.js      — conversations.open, chat.postMessage, intro message builder
  db/
    connection.js     — node:sqlite singleton
    init.js           — CREATE TABLE IF NOT EXISTS, default settings seed
  lib/
    users.js          — user + exclusion DB helpers
    rounds.js         — round, match, pair history, settings DB helpers
    adminGuard.js     — isAdmin() check
docs/
  SLACK_CONCEPTS.md   — Slack app concepts reference
  PRODUCTION.md       — deployment guide
  DONUT_COMPARISON.md — feature comparison vs. Donut
scripts/
  db-init.js          — run db init standalone
  db-reset.js         — wipe and recreate (dev only)
  test-commands.js    — user command smoke tests
  test-dry-run.js     — dry-run smoke test
  test-run.js         — run smoke test (mock Slack client)
  test-admin.js       — admin command smoke tests
  test-scheduler.js   — scheduler logic tests
tests/
  matching.test.js    — 35 unit tests (node:test)
```

---

## Environment Variables

See [`.env.example`](.env.example) for the full list. Required for Slack:

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...
ADMIN_USER_IDS=U01ABC123,U02DEF456
SCHEDULING_ENABLED=true   # false in local dev
```

---

## Build Phases

- [x] Phase 0 — Discovery + Slack concepts
- [x] Phase 1 — Basic app skeleton (Express, health endpoint)
- [x] Phase 2 — SQLite persistence (schema, db:init, db:reset)
- [x] Phase 3 — User participation commands (join, pause, resume, leave, status)
- [x] Phase 4 — Matching engine (Fisher-Yates, greedy repeat-avoidance, 35 unit tests)
- [x] Phase 5 — Admin dry run
- [x] Phase 6 — Admin real run (Slack DMs, pair history, partial-failure tolerance)
- [x] Phase 7 — Admin management commands (summary, participants, set, exclude/include, etc.)
- [x] Phase 8 — Scheduled automation (minute-tick scheduler, cadence guard)
- [x] Phase 9 — Production hardening (crash recovery, graceful shutdown, deployment guide)
