# Watercooler — Azure Hosting Guide

> **Goal:** Move the app off a developer laptop and onto a server that runs 24/7,
> so matching, scheduling, and calendar bookings happen automatically without
> anyone needing to be at their computer.

---

## Who Does What

This guide is split between two people:

- **🔑 Admin** — someone with Azure permissions to register resource providers, create resource groups, and create the VM. These steps require subscription-level rights.
- **🙋 You** — the app maintainer. You don't have admin rights, but once the Admin hands over a running VM (its IP address + SSH access), you can do everything else: install Node, deploy the code, set environment variables, and keep it running.

Each step below is tagged with who performs it. **Steps 0–1 are the Admin's.** Everything from Step 2 onward is yours.

> ⚠️ **Before the Admin starts:** confirm VMs are even allowed on the target subscription. Some restricted subscriptions (e.g. partner/sponsored ones) have the **Microsoft.Compute** provider disabled and block VM creation entirely. If that's the case, this VM path won't work and you'll need the App Service path instead — ask the Admin to confirm first so no time is wasted.

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

An Azure VM is the simplest path. The database is **SQLite** — a single file that lives on the VM's disk. There is **no database server and no connection string**; the app just reads/writes a file at the path given by the `DATABASE_PATH` environment variable. Nothing extra to provision, no code changes needed.

> 💡 If an Admin (or another tool) set up an **Azure SQL database**, it is **not used** by this app and can be deleted — see the cleanup note at the end. This app uses SQLite only.

**Recommended VM size:** `B1s` (1 vCPU, 1 GB RAM, ~$8/mo) is plenty for ~50 users. `B2s` (~$30/mo) adds headroom if you want it. Avoid the portal's default size (often `D2s_v3` at ~$70/mo) — it's far more than this app needs.

**OS:** Ubuntu Server 24.04 LTS

---

## Step 0 — Subscription Setup  🔑 *Admin*

These cause the "resource provider not registered / no permission to create resource groups" errors if skipped. They're one-time, subscription-level actions only an Admin can do.

1. **Register resource providers.** Subscription → **Resource providers** → search for and **Register** each of:
   - `Microsoft.Compute`
   - `Microsoft.Storage`
   - `Microsoft.Network`
2. **Create a resource group** named `watercooler-rg`.

---

## Step 1 — Create the VM  🔑 *Admin*

> 🙋 **Your part first:** before the Admin starts, generate an SSH key on your Mac so you can log in later, and send the Admin the *public* half. In your Mac Terminal:
> ```bash
> ssh-keygen -t ed25519 -C "watercooler" -f ~/.ssh/watercooler_vm
> # press Enter through the prompts, then:
> cat ~/.ssh/watercooler_vm.pub
> ```
> Copy that output line and send it to the Admin. The private key stays on your machine.

In the Azure Portal, go to **Virtual Machines → Create → Azure virtual machine**, and use these values on the **Basics** tab:

| Field | Value | Notes |
|---|---|---|
| Subscription | *(the approved subscription)* | |
| Resource group | `watercooler-rg` | from Step 0 |
| Virtual machine name | `watercooler-vm` | |
| Region | East US | or closest to the team |
| Availability options | **No infrastructure redundancy required** | single small VM |
| Security type | Trusted launch virtual machines | default is fine |
| Image | **Ubuntu Server 24.04 LTS – x64 Gen2** | |
| VM architecture | x64 | |
| Run with Azure Spot discount | **No / unchecked** | Spot VMs can be shut off — bad for always-on |
| **Size** | **Standard_B1s** | ⚠️ change from the default `D2s_v3` (~$70/mo). B1s ≈ $8/mo and is plenty. B2s for headroom. |
| Authentication type | SSH public key | |
| Username | `azureuser` | |
| SSH public key source | **Use existing public key** | paste the `.pub` line from "Your part first" above |
| Public inbound ports | **Allow selected ports → SSH (22)** | the only port needed — the app makes outbound connections to Slack, nothing inbound |

**Disks tab:** set **OS disk type → Standard SSD** (cheaper than the Premium SSD default; fine for this workload).

**Networking / Management / Monitoring / Advanced / Tags tabs:** leave at defaults.

Then **Review + Create → Create**.

**When it's done, the Admin gives you two things:** the VM's **public IP address** and confirmation it's running. That's the handoff point — everything below is yours.

---

## Step 2 — Connect and Install Node.js  🙋 *You*

SSH into the VM using the key you generated in Step 1:
```bash
ssh -i ~/.ssh/watercooler_vm azureuser@<your-vm-ip>
```

Install Node.js 24 (required — the app uses Node's built-in SQLite module added in Node 22+):
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # should show v24.x.x
```

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

## Step 3 — Copy the App Code  🙋 *You*

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

## Step 4 — Migrate the Database  🙋 *You*

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

## Step 5 — Set Environment Variables  🙋 *You*

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

# Database — just a file path on the VM's disk (NOT a connection string).
# SQLite creates this file automatically on first start.
DATABASE_PATH=/home/azureuser/watercooler/data/watercooler.db

# Scheduler — set to true so rounds run automatically
SCHEDULING_ENABLED=true

# Calendar (Outlook integration) — OPTIONAL.
# Leave these out entirely and the app still runs; you just won't get
# calendar slot suggestions or Teams links. Add later once IT completes
# the Azure AD app registration (see docs/OUTLOOK_INTEGRATION.md).
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
CALENDAR_ENABLED=true
CALENDAR_TIMEZONE=America/New_York
```

> **Key differences from your local `.env`:**
> - `SCHEDULING_ENABLED=true` — on your laptop this was probably `false`; on the server it should be `true`
> - `DATABASE_PATH` — use an absolute path to avoid issues with the working directory
>
> **Note:** there is no database username, password, or connection string. The "database" is the single SQLite file at `DATABASE_PATH`. If anyone set up an Azure SQL database, it is not used here.

Save and close (`Ctrl+X`, then `Y`, then `Enter`).

---

## Step 6 — Test That It Starts  🙋 *You*

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

## Step 7 — Run as a Background Service (PM2)  🙋 *You*

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

## Step 8 — Verify the Scheduler  🙋 *You*

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

## Step 9 — Database Backups  🙋 *You*

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

## Cleanup — Remove Unused Resources  🔑 *Admin*

If an earlier attempt created an **Azure App Service** (a `*.azurewebsites.net` web app) or an **Azure SQL database**, neither is used by this app once it's running on the VM. Leaving them around just adds to the monthly bill.

Once the VM has been running cleanly for a few days, the Admin can delete:
- The App Service / App Service Plan
- The Azure SQL database and its server

The simplest way is to delete the **resource group** they live in — but only if it contains *just* those unused resources. If they share a resource group with the VM, delete them individually instead.

---

## Related Docs

- [PRODUCTION.md](PRODUCTION.md) — Slack app setup, environment variables reference, full troubleshooting list
- [OUTLOOK_INTEGRATION.md](OUTLOOK_INTEGRATION.md) — Azure AD app registration and calendar permissions
