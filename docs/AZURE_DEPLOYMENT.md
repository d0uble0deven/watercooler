# Watercooler — Azure Hosting Guide

> **Goal:** Move the app off a developer laptop and onto a server that runs 24/7,
> so matching, scheduling, and calendar bookings happen automatically without
> anyone needing to be at their computer.

---

## What You're Deploying

Watercooler is a Node.js app that:
- Connects to Slack over a persistent WebSocket (Socket Mode — no public URL needed)
- Reads a single SQLite database file on disk
- Runs a scheduler that fires once per minute to check if a match round should start
- Makes outbound API calls to Slack and Microsoft Graph

It does **not** need:
- A public domain name or SSL certificate
- Inbound firewall rules
- A load balancer
- A database server

Just a VM with Node.js installed, an internet connection, and the app running as a background process.

---

## Recommended Approach: Azure VM with SQLite

An Azure VM is the simplest path. The SQLite database is a single file that lives on the VM's disk — nothing special to configure for persistence. The app already reads its connection string from an environment variable, so no code changes are needed.

**Recommended VM size:** `B1s` or `B2s` (1–2 vCPUs, 1–4 GB RAM) — the app is very lightweight.

**OS:** Ubuntu 22.04 LTS (or any Linux distro you're comfortable with)

---

## Step 1 — Provision the VM

1. In the Azure Portal, go to **Virtual Machines → Create**
2. Choose your subscription and resource group (or create a new one, e.g. `watercooler-rg`)
3. Select a region close to your team
4. Image: **Ubuntu Server 22.04 LTS**
5. Size: **B2s** is plenty
6. Authentication: SSH public key (recommended) or password
7. Under **Networking**, make sure port **22 (SSH)** is open for your IP
   - The app does **not** need any other inbound ports — it connects out to Slack, not the other way
8. Click **Review + Create** → **Create**

Once the VM is created, note its **public IP address**.

---

## Step 2 — Connect and Install Node.js

SSH into the VM:
```bash
ssh azureuser@<your-vm-ip>
```

Install Node.js 24 (required — the app uses Node's built-in SQLite module added in Node 22+):
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # should show v24.x.x
```

---

## Step 3 — Copy the App Code

**Option A — From GitHub (recommended)**

If the code is in a GitHub repository:
```bash
git clone https://github.com/your-org/watercooler.git
cd watercooler
npm install
```

**Option B — Direct file copy from local machine**

From your local machine (not the VM):
```bash
scp -r /path/to/watercooler azureuser@<your-vm-ip>:~/watercooler
```

Then on the VM:
```bash
cd ~/watercooler
npm install
```

---

## Step 4 — Migrate the Database

The existing database holds all participant records, match history, and settings. Copy it to the VM so nothing is lost.

From your local machine:
```bash
scp /path/to/watercooler/data/watercooler.db azureuser@<your-vm-ip>:~/watercooler/data/watercooler.db
```

> ⚠️ Make sure the `data/` directory exists on the VM first:
> ```bash
> mkdir -p ~/watercooler/data
> ```

If you are starting fresh (no existing data to migrate), skip this step — the app will create a new database automatically on first start.

---

## Step 5 — Set Environment Variables

Create the `.env` file on the VM. **Do not copy your local `.env` directly** — update `SCHEDULING_ENABLED` and `DATABASE_PATH` to their correct production values.

```bash
nano ~/watercooler/.env
```

Paste and fill in all values:

```env
# Slack — copy from your existing local .env
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...

# Server
PORT=3000
ADMIN_USER_IDS=U01ABC123,U02DEF456

# Database — absolute path is safest on a server
DATABASE_PATH=/home/azureuser/watercooler/data/watercooler.db

# Scheduler — set to true so rounds run automatically
SCHEDULING_ENABLED=true

# Calendar (Outlook integration)
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
CALENDAR_ENABLED=true
CALENDAR_TIMEZONE=America/New_York
```

> **Key differences from your local `.env`:**
> - `SCHEDULING_ENABLED=true` — on your laptop this was probably `false`; on the server it should be `true`
> - `DATABASE_PATH` — use an absolute path to avoid issues with the working directory

Save and close (`Ctrl+X`, then `Y`, then `Enter`).

---

## Step 6 — Test That It Starts

Before setting up permanent background running, verify the app starts cleanly:

```bash
cd ~/watercooler
npm start
```

Expected output:
```
✅ Database ready: /home/azureuser/watercooler/data/watercooler.db
🚀 Watercooler running on http://localhost:3000
⚡️ Slack Bolt connected via Socket Mode
[Scheduler] Started — checking every minute for a scheduled run.
[INFO]  socket-mode:SocketModeClient:0 Now connected to Slack
```

Once you see `Slack Bolt connected`, go to Slack and run:
```
/watercooler admin settings
```

You should get the settings response back. If you do, the app is working from the server.

Press `Ctrl+C` to stop it — you'll start it properly in the next step.

---

## Step 7 — Run as a Background Service (PM2)

PM2 keeps the app running after you close your SSH session and restarts it automatically if the server reboots.

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start the app
cd ~/watercooler
pm2 start npm --name watercooler -- start

# Save the process list so it survives reboots
pm2 save

# Configure PM2 to start on system boot
pm2 startup
# Follow the instruction it prints (it'll give you a sudo command to run)
```

Useful PM2 commands:
```bash
pm2 status                  # see if the app is running
pm2 logs watercooler        # live log output
pm2 logs watercooler --lines 100   # last 100 lines
pm2 restart watercooler     # restart after a config change
pm2 stop watercooler        # stop the app
```

---

## Step 8 — Verify the Scheduler

Since `SCHEDULING_ENABLED=true` on the server, the scheduler is now live. Confirm it's working:

```bash
pm2 logs watercooler
```

You should see a line every minute:
```
[calendarAutoBooker] ...   (checking for overdue bookings)
```

And on the configured intro day/time:
```
[Scheduler] 🚀 Triggering run — cadence: triweekly, day: monday, time: 10:00
```

---

## Step 9 — Database Backups

SQLite is a single file. Set up a daily backup cron job so you can recover if anything goes wrong.

```bash
crontab -e
```

Add this line (backs up every night at 2 AM, keeps 30 days of history):
```bash
0 2 * * * cp /home/azureuser/watercooler/data/watercooler.db \
  /home/azureuser/watercooler/data/backups/watercooler-$(date +\%Y\%m\%d).db \
  2>/dev/null; find /home/azureuser/watercooler/data/backups -name 'watercooler-*.db' -mtime +30 -delete
```

Create the backups folder first:
```bash
mkdir -p ~/watercooler/data/backups
```

**To restore from a backup:**
```bash
pm2 stop watercooler
cp ~/watercooler/data/backups/watercooler-YYYYMMDD.db ~/watercooler/data/watercooler.db
pm2 start watercooler
```

---

## Deploying Code Updates

When a developer makes changes to the code:

**If using GitHub:**
```bash
cd ~/watercooler
git pull
npm install        # only needed if package.json changed
pm2 restart watercooler
```

**If copying files manually:**
```bash
# From local machine:
scp -r /path/to/updated/src azureuser@<vm-ip>:~/watercooler/src

# On the VM:
pm2 restart watercooler
```

> ⚠️ Never overwrite the `data/` folder when deploying — that's where the database lives.

---

## Health Check

The app exposes a health endpoint you can monitor:

```
GET http://<vm-ip>:3000/health
→ { "status": "ok", "slack_connected": true, "timestamp": "..." }
```

Point any uptime monitoring tool (Azure Monitor, UptimeRobot, etc.) at this URL.
Alert if the response is non-200 or if `slack_connected` is `false`.

> The health endpoint is only reachable if you open port 3000 in the VM's Network Security Group.
> If you don't want to expose it publicly, it can be monitored from within Azure's network only.

---

## Turning the App Off Temporarily

```bash
pm2 stop watercooler    # stops the app — no rounds will fire, no DMs sent
pm2 start watercooler   # brings it back
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| App starts but Slack commands don't respond | Wrong `SLACK_BOT_TOKEN` or `SLACK_APP_TOKEN` | Re-copy tokens from Slack app dashboard |
| Scheduler never fires | `SCHEDULING_ENABLED` not `true` | Check `.env`, then `pm2 restart watercooler` |
| Calendar suggestions not showing | `CALENDAR_ENABLED` not `true`, or Azure credentials wrong | Run `/watercooler admin calendar-status` in Slack |
| App crashes on startup with `EADDRINUSE` | Something else using port 3000 | Change `PORT=3001` in `.env` |
| Database missing after redeploy | `data/` folder was overwritten | Restore from backup; never copy `data/` during deploys |
| `missing_scope` in logs | Slack bot token doesn't have a required scope | Add scope at api.slack.com → reinstall app |
| App offline after VM reboot | PM2 startup not configured | Run `pm2 startup` and follow the printed command |

---

## Related Docs

- [PRODUCTION.md](PRODUCTION.md) — Slack app setup, environment variables reference, full troubleshooting list
- [OUTLOOK_INTEGRATION.md](OUTLOOK_INTEGRATION.md) — Azure AD app registration and calendar permissions
