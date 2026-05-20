# Watercooler

Internal Slack app for casual 1:1 social matching — similar to Donut, without participant limits.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Create your .env (don't commit this)
cp .env.example .env

# 3. Start the server (works without Slack credentials)
npm start

# OR: watch mode (auto-restarts on file changes)
npm run dev
```

The server starts on `http://localhost:3000`. Check the health endpoint:

```bash
curl http://localhost:3000/health
```

Expected response (before Slack credentials are set):
```json
{ "status": "ok", "slack_connected": false, "timestamp": "..." }
```

## Connecting to Slack

See [docs/SLACK_CONCEPTS.md](docs/SLACK_CONCEPTS.md) for a plain-English explanation of every Slack concept used here.

1. Create a Slack app at https://api.slack.com/apps
2. Enable Socket Mode and generate an App-Level Token (`xapp-...`)
3. Add the required bot scopes (see docs/SLACK_CONCEPTS.md → Scopes)
4. Install to workspace and copy the Bot Token (`xoxb-...`)
5. Copy Signing Secret from Basic Information
6. Fill in `.env` with all three tokens
7. Restart — you'll see `⚡️ Slack Bolt connected via Socket Mode`

## Commands

| Command | Who | Description |
|---|---|---|
| `/watercooler status` | Everyone | Check your participation status |
| `/watercooler join` | Everyone | Opt in to matching *(Phase 3)* |
| `/watercooler pause` | Everyone | Pause matching temporarily *(Phase 3)* |
| `/watercooler resume` | Everyone | Resume after pausing *(Phase 3)* |
| `/watercooler leave` | Everyone | Opt out entirely *(Phase 3)* |
| `/watercooler admin run` | Admins | Trigger a matching round *(Phase 6)* |
| `/watercooler admin dry-run` | Admins | Preview matches without sending DMs *(Phase 5)* |

## Project structure

```
src/
  app.js          — entry point: Express + Slack Bolt bootstrap
  config.js       — reads environment variables
  commands/       — slash command handlers (Phase 3+)
  matching/       — pure matching algorithm (Phase 4+)
  slack/          — Slack DM creation + messaging (Phase 6+)
  db/             — SQLite connection + schema (Phase 2+)
  lib/            — shared helpers (admin guard, etc.)
docs/
  SLACK_CONCEPTS.md  — plain-English guide to Slack app concepts
scripts/
  db-init.js      — create tables (Phase 2+)
  db-reset.js     — drop + recreate tables (dev only, Phase 2+)
```

## Build phases

- [x] Phase 0 — Discovery + Slack concepts
- [x] Phase 1 — Basic app skeleton ← you are here
- [ ] Phase 2 — SQLite persistence
- [ ] Phase 3 — User participation commands
- [ ] Phase 4 — Matching engine
- [ ] Phase 5 — Admin dry run
- [ ] Phase 6 — Admin real run
- [ ] Phase 7 — Admin management commands
- [ ] Phase 8 — Scheduled automation
- [ ] Phase 9 — Production readiness review
