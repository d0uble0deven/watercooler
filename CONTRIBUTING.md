# Contributing to Watercooler

Welcome! Watercooler is DocMe360's internal Slack app that pairs teammates for
casual 15-minute virtual coffees — matching, scheduling against Outlook
calendars, Teams links, and follow-ups, all inside Slack.

## The 60-Second Orientation

- **This repo's `main` branch is production.** The app runs 24/7 on an Azure VM
  that deploys directly from `main`. Treat every merge accordingly.
- **Merging does not auto-deploy.** The maintainer deploys manually
  (SSH → `git pull` → `pm2 restart`). Your merged change goes live at the next
  deploy, not the moment you merge.
- **All changes go through pull requests into `main`.** No direct pushes.
- **Stack:** Node.js 24+ (required — the app uses the built-in `node:sqlite`),
  Slack Bolt (Socket Mode), Microsoft Graph for calendars, plain CommonJS
  JavaScript. No TypeScript, no build step, no ORM, four runtime dependencies.
  Keep it that way unless there's a strong reason not to.

## Local Setup

```bash
git clone git@github.com:DocMe360/watercooler.git
cd watercooler
npm install
cp .env.example .env    # see "Secrets" below
npm start               # → http://localhost:3000/health
```

**Secrets:** the app starts fine without any credentials — slash commands and
calendar calls just won't work until tokens are added. For most code + test work
you don't need any. If your change needs live Slack/calendar testing, ask the
maintainer about test credentials. **Never commit `.env`** (it's gitignored;
keep it that way) and never paste tokens into code, tests, or PR descriptions.

## Running Tests

```bash
npm run test:all        # every suite (~400 assertions)
```

Or individual suites while developing — the most commonly useful:

| Command | Covers |
|---|---|
| `npm test` | matching engine |
| `npm run test:scheduler` | cadence / day / time logic |
| `npm run test:admin-commands` | admin workflow commands |
| `npm run test:enrollment` | channel-based auto-enrollment |
| `npm run test:reschedule` | reschedule flow |
| `npm run test:fun-facts` | fun-fact picker + invite email body |
| `npm run test:tz-intersection` | multi-timezone scheduling math |

Notes:
- Tests run against a local SQLite file — no external services needed, **except**
  a few `test:cal-*` suites that hit the real Microsoft Graph API and require
  Azure credentials in `.env`. Without them, run everything else and let the
  maintainer's `test:all` cover the rest.
- Test scripts follow a simple house pattern (see any `scripts/test-*.js`):
  a `check(label, condition)` helper, namespaced test data (e.g. `U_XYZ_*`)
  cleaned up before and after, and a pass/fail tally that exits non-zero on
  failure. New features should ship with a suite in the same style, wired into
  `test:all` in `package.json`.

## Making a Change

1. **Branch off `main`:** `git checkout -b feat/short-description`
2. Make the change. Match the codebase's conventions:
   - CommonJS (`require`/`module.exports`), `'use strict'` at the top
   - DB access goes through helpers in `src/lib/` (never inline SQL in command
     handlers); schema changes are **additive `ALTER TABLE` migrations** in
     `src/db/init.js` (they run automatically and must be idempotent)
   - User-facing Slack copy is warm and casual (☕ is basically the mascot)
   - Every Slack handler `ack()`s fast and fails soft — a calendar or API error
     must never take down a round
3. **Run the tests.** Add tests for new behavior.
4. Push your branch and **open a PR into `main`** with a short description of
   what changed and how you verified it.
5. After merge, the maintainer deploys. If your change needs anything beyond
   `git pull && pm2 restart` (a new env var, a Slack scope, a manual command),
   **say so prominently in the PR description.**

## Repo Map (where things live)

```
src/app.js               entry point — Express health check + Bolt wiring
src/commands/user/       /watercooler join, pause, resume, leave, status
src/commands/admin/      /watercooler admin … (router + one file per command)
src/commands/actions/    button-click handlers (book slot, reschedule, feedback)
src/commands/events/     Slack event handlers (channel join/leave enrollment)
src/matching/engine.js   pure matching algorithm
src/scheduler/           minute-tick scheduler + cadence guard
src/integrations/        Microsoft Graph: free/busy, booking, auto-book, follow-ups
src/lib/                 DB helpers (users, rounds), slot finder, enrollment
src/data/funFacts.js     conversation starters for invites — easiest first PR:
                         add facts here (true, SFW, 1–2 sentences, no myths)
src/db/init.js           schema + additive migrations (auto-run on startup)
scripts/test-*.js        test suites            docs/       all documentation
```

Deeper dives: [README.md](README.md) for the full command list and structure,
[docs/USER_MANUAL.md](docs/USER_MANUAL.md) for what every command does,
[docs/REPO_MIGRATION.md](docs/REPO_MIGRATION.md) for how this repo relates to
the maintainer's personal copy and the production VM.

## Ground Rules

- **Never commit `.env`, tokens, or anything from the `data/` directory** (the
  production database lives at `data/` on the VM — local `data/` is gitignored)
- Don't bump `node_modules` / add dependencies without discussing first
- Schema changes: additive migrations only — never rewrite or drop existing
  columns/tables (the prod DB migrates in place on restart)
- If you're unsure whether something is safe for prod, ask before merging —
  a real round DMs real coworkers
