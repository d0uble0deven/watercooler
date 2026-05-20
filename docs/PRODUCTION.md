# Watercooler — Production Deployment Guide

Everything you need to take Watercooler from local dev to a real Slack workspace.

---

## 1. Create the Slack App

Go to **https://api.slack.com/apps** → **Create New App → From scratch**.

Name it `Watercooler` (or whatever you like) and pick your workspace.

---

## 2. Enable Socket Mode

**Settings → Socket Mode → Enable**

Generate an **App-Level Token** with the `connections:write` scope.
Copy the token — it starts with `xapp-`. This is your `SLACK_APP_TOKEN`.

> Socket Mode means Slack connects **out to your server** over a WebSocket.
> No public URL, no ngrok, no firewall rules needed.

---

## 3. Add Bot Token Scopes

**Features → OAuth & Permissions → Bot Token Scopes**

Add all of these:

| Scope | Why it's needed |
|---|---|
| `commands` | Receive `/watercooler` slash commands |
| `chat:write` | Post messages into DMs and the announcement channel |
| `im:write` | Open 1-on-1 DMs between the bot and users |
| `mpim:write` | Open multi-person DMs (group trios) |

> **Missing a scope?** Slack will return a `missing_scope` error when the run fires.
> Check the server logs — the error message names the missing scope exactly.

---

## 4. Create the Slash Command

**Features → Slash Commands → Create New Command**

| Field | Value |
|---|---|
| Command | `/watercooler` |
| Request URL | `https://placeholder.example.com` (Socket Mode ignores this) |
| Short Description | `Casual 1:1 matching for your team` |
| Usage Hint | `join \| pause \| resume \| leave \| status \| admin …` |

Save it.

---

## 5. Install to Workspace

**OAuth & Permissions → Install to Workspace**

After authorising, copy the **Bot User OAuth Token** — it starts with `xoxb-`.
This is your `SLACK_BOT_TOKEN`.

---

## 6. Get the Signing Secret

**Basic Information → App Credentials → Signing Secret**

This is your `SLACK_SIGNING_SECRET`.

---

## 7. Find Admin User IDs

For each person who should be able to run admin commands:

1. Open Slack → click their profile
2. Click the **⋮** (more) menu → **Copy member ID**

The ID starts with `U` — e.g. `U01ABC123`.

---

## 8. Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...

PORT=3000
ADMIN_USER_IDS=U01ABC123,U02DEF456

DATABASE_PATH=./data/watercooler.db

# Set to true once you're ready for automated runs
SCHEDULING_ENABLED=true
```

> **Never commit `.env` to git.** It's already in `.gitignore`.

---

## 9. First Run Checklist

```bash
# 1. Install dependencies (first time only)
npm install

# 2. Verify the database initialises cleanly
npm run db:init

# 3. Start the app
npm start
```

Expected output:
```
✅ Database ready: ./data/watercooler.db
🚀 Watercooler running on http://localhost:3000
⚡️ Slack Bolt connected via Socket Mode
[Scheduler] Started — checking every minute for a scheduled run.
```

If you see `⚠️ ADMIN_USER_IDS is not set`, add your Slack user ID to `.env` and restart.

---

## 10. Configure the Scheduler

Once connected, run these slash commands from Slack:

```
/watercooler admin set intro-day monday
/watercooler admin set intro-time 09:00
/watercooler admin set cadence weekly
/watercooler admin set channel C01YOURCHANNEL
```

Then test with a dry run:
```
/watercooler admin dry-run
```

When you're satisfied:
```
/watercooler admin run
```

---

## 11. Process Management

### PM2 (recommended)

```bash
npm install -g pm2
pm2 start npm --name watercooler -- start
pm2 save
pm2 startup   # auto-restart on server reboot
```

Check logs:
```bash
pm2 logs watercooler
```

### systemd (Linux VPS)

```ini
# /etc/systemd/system/watercooler.service
[Unit]
Description=Watercooler Slack App
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/watercooler
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/app.js
Restart=on-failure
RestartSec=10
EnvironmentFile=/path/to/watercooler/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable watercooler
sudo systemctl start watercooler
sudo journalctl -u watercooler -f   # live logs
```

---

## 12. Health Check & Monitoring

The app exposes a health endpoint:

```
GET http://localhost:3000/health
→ { "status": "ok", "slack_connected": true, "timestamp": "…" }
```

Point any uptime monitor (UptimeRobot, Better Uptime, Render health checks) at it.
Alert on non-200 responses or if `slack_connected` flips to `false`.

---

## 13. Database Backups

SQLite is a single file. Back it up with a cron job:

```bash
# Daily backup, keep 30 days
0 2 * * * cp /path/to/watercooler/data/watercooler.db \
  /path/to/backups/watercooler-$(date +\%Y\%m\%d).db \
  && find /path/to/backups -name 'watercooler-*.db' -mtime +30 -delete
```

Restore: copy the `.db` file back and restart.

---

## 14. SQLite vs Postgres

SQLite is the right choice for this app **unless** one of these applies:

| Condition | Recommendation |
|---|---|
| Team < 200, weekly runs | ✅ Keep SQLite |
| Multiple app replicas (horizontal scale) | Migrate to Postgres |
| More than a few runs per day | Migrate to Postgres |
| You need a managed DB with point-in-time recovery | Migrate to Postgres |

**What a Postgres migration would require:**

1. Add `pg` package (`npm install pg`)
2. All functions in `src/lib/` are synchronous (`node:sqlite` API) — they'd need to become `async/await`
3. Update SQL: `datetime('now')` → `NOW()`, `INTEGER` → `BIGSERIAL` for auto-increment, `PRAGMA` → Postgres equivalents
4. Replace `getDb()` singleton with a `pg.Pool`

The schema is simple enough that migration is straightforward — the business logic in commands and the matching engine are completely DB-agnostic.

---

## 15. Common Problems

| Symptom | Cause | Fix |
|---|---|---|
| `⚠️ ADMIN_USER_IDS is not set` | Empty env var | Add your Slack member ID to `.env` |
| All admin commands blocked with `⛔` | Wrong user ID in `ADMIN_USER_IDS` | Double-check the ID from Slack profile → Copy member ID |
| `missing_scope` error in logs | Bot token missing a scope | Add the scope in Slack app dashboard → reinstall |
| Round is stuck, new runs blocked | Previous crash left a `pending` round | Restart the app — `cancelStuckRounds()` clears it automatically on startup |
| Scheduler never fires | `SCHEDULING_ENABLED` not set to `true` | Set it in `.env` and restart |
| `EADDRINUSE` on startup | Port 3000 already in use | Kill the old process or set `PORT=3001` in `.env` |
| `conversations.open` fails | `im:write` or `mpim:write` scope missing | Add scopes and reinstall the app |

---

## 16. Required Node Version

Node **24+** (uses the built-in `node:sqlite` module added in Node 22/24).

Check: `node --version`

If you're on an older Node, upgrade via [nvm](https://github.com/nvm-sh/nvm):
```bash
nvm install 24
nvm use 24
```
