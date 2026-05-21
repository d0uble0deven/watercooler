# Watercooler — Outlook Calendar Integration

---

# ✉️ FOR IT / MICROSOFT ADMIN

> **This section is everything you need. You can ignore everything below the divider.**

---

## What We're Building

We have an internal Slack app called Watercooler that randomly pairs DocMe360 employees for casual 15-minute virtual coffee chats. Right now it sends people a DM intro and they schedule the meeting themselves.

We want to improve it so the app automatically:
1. Reads both people's Outlook calendars to find when they're both free
2. Suggests a few time slots directly in the Slack message
3. Creates a calendar invite with a Teams meeting link when someone picks a time

To do this, the app needs permission to read and write to Microsoft 365 calendars on behalf of the organization. This is a one-time setup in Azure Active Directory — no ongoing work required from you after this.

---

## What You Need to Do

**Time required:** ~15 minutes
**Where:** https://portal.azure.com
**What you'll send back:** 3 credential values (Tenant ID, Client ID, Client Secret)

---

### Step 1 — Sign in to Azure Portal

Go to **https://portal.azure.com** and sign in with your DocMe360 Microsoft 365 admin account.

---

### Step 2 — Register a New App

1. In the search bar at the top, type **"App registrations"** and click it
2. Click **"+ New registration"**
3. Fill in the following:
   - **Name:** `Watercooler`
   - **Supported account types:** select `Accounts in this organizational directory only (DocMe360 only - Single tenant)`
   - **Redirect URI:** leave this blank
4. Click **Register**

You'll land on the app overview page. **Leave this page open** — you'll need two values from it in Step 5.

---

### Step 3 — Add API Permissions

1. In the left sidebar, click **"API permissions"**
2. Click **"+ Add a permission"**
3. Click **"Microsoft Graph"**
4. Click **"Application permissions"** ← important: make sure it's Application, not Delegated
5. Search for and add each of these four permissions one at a time:

| Permission to add | Why the app needs it |
|---|---|
| `Calendars.Read` | Read employees' calendars to find times when both people are free |
| `Calendars.ReadWrite` | Create the calendar invite once a meeting time is confirmed |
| `OnlineMeetings.ReadWrite` | Generate a Teams meeting link to include in the invite |
| `User.Read.All` | Look up each employee's email address and timezone |

6. Click **"Add permissions"**
7. You'll see a yellow warning banner — click the blue button **"Grant admin consent for DocMe360"** then click **Yes** to confirm

> ⚠️ This last consent step is required. The permissions won't be active until you click it.

---

### Step 4 — Create a Client Secret

1. In the left sidebar, click **"Certificates & secrets"**
2. Click **"+ New client secret"**
3. Set the description to `Watercooler app secret`
4. Set expiry to **24 months** (or whatever your org standard is)
5. Click **Add**
6. A new row will appear in the table. **Immediately copy the value in the "Value" column** — it's a long string of letters and numbers

> ⚠️ This value is only shown once. If you navigate away before copying it you'll need to delete it and create a new one.

---

### Step 5 — Send These 3 Values Back

Go back to the app overview page (click **"Overview"** in the left sidebar).

You need to send the developer three values.

```
AZURE_TENANT_ID     =   the "Directory (tenant) ID" on the overview page
AZURE_CLIENT_ID     =   the "Application (client) ID" on the overview page
AZURE_CLIENT_SECRET =   the long value you copied in Step 4
```

---

### ✅ You're Done

That's everything. The app will use these credentials to authenticate with Microsoft 365 — no individual employees need to log in or authorize anything, and no further involvement is needed from you unless the client secret expires (in 24 months) or permissions need to change.

If something isn't working after the developer plugs in the credentials, the most likely cause is that the **"Grant admin consent"** click in Step 3 was missed — that's the first thing to double-check.

---
---

# 👩‍💻 FOR THE DEVELOPER

Everything below is the developer-side setup. To be done after IT has provided the three credential values above.

---

## How the Feature Works (Overview)

After two people are matched, instead of just sending an intro DM, the app will:

1. Read both people's Outlook calendars for the next 3 weeks
2. Find overlapping 15-minute free slots within each person's business hours (9 AM–5 PM in their local timezone)
3. Post 3 suggested times as clickable buttons in the group DM
4. When one person clicks — create a calendar invite + Teams link for both
5. If nobody clicks within the configured deadline — auto-book the first available slot

**Fallback:** if calendar access fails for any reason, the regular intro DM is sent. The round never fails because of a calendar issue.

---

## Step 1 — Add Credentials to `.env`

```env
# Microsoft Graph — values provided by IT
AZURE_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_SECRET=your-secret-value-here

# Keep false until ready to test end-to-end
CALENDAR_ENABLED=false
```

---

## Step 2 — Restart and Verify Connection

```bash
npm start
```

Expected startup output:
```
[Calendar] Microsoft Graph client initialised (calendar disabled — set CALENDAR_ENABLED=true to enable)
```

Then verify in Slack:
```
/watercooler admin calendar-status
```

Expected response:
```
✅ Microsoft Graph connected — calendar integration is ready.
   CALENDAR_ENABLED is currently false.
   Run /watercooler admin set calendar-enabled true to activate.
```

If you see an auth error, check the three credential values and confirm IT clicked "Grant admin consent" in Step 3 of their setup.

---

## Step 3 — Configure Settings

```
/watercooler admin set calendar-enabled true
/watercooler admin set meeting-duration 15
/watercooler admin set booking-deadline 2.5
```

| Setting | Default | Notes |
|---|---|---|
| `calendar-enabled` | `false` | Master on/off switch |
| `meeting-duration` | `15` | Minutes |
| `booking-deadline` | `2.5` | Days before auto-book. Supports decimals — 2.5 = 60 hours. Example: matches sent Monday 10 AM → auto-book fires Wednesday 10 PM |

All settings appear in `/watercooler admin settings`.

---

## Step 4 — Test with a Dry Run

```
/watercooler admin dry-run
```

The preview will now show whether calendar slots were found for each pair alongside the match preview. No DMs sent, no invites created.

---

## Step 5 — Test with a Real Run (Small Group)

1. Make sure only 2 people are joined: `/watercooler admin participants`
2. Run `/watercooler admin run`
3. Check the group DM — intro message + 3 time slot buttons should appear
4. Click one — verify the calendar invite and Teams link arrive in Outlook
5. Confirm booking status: `/watercooler admin recent-rounds`

---

## Turning It Off

```
/watercooler admin set calendar-enabled false
```

Future rounds fall back to the regular intro DM. Existing booked invites are not affected.

---

## Business Hours Logic

Slots are filtered to **9 AM – 5 PM in each person's local timezone**, read automatically from their Microsoft 365 profile. No configuration needed.

**Example — California (PT) + Maine (ET):**
- 12:00 PM ET = 9:00 AM PT → valid for both ✅
- 8:00 AM ET = 5:00 AM PT → too early for California ❌
- Practical overlap: roughly **12:00 PM – 5:00 PM ET**

---

## What Employees See

**In the group DM:**
> 👋 Hi Alice and Bob! I've matched you for a Watercooler chat! ☕
>
> 📅 Here are some times you're both free:
>
> Thu Jun 5 · 12:00–12:15 PM ET &nbsp; `[Book this]`
> Fri Jun 6 · 2:00–2:15 PM ET &nbsp;&nbsp;&nbsp; `[Book this]`
> Mon Jun 9 · 1:00–1:15 PM ET &nbsp;&nbsp; `[Book this]`
>
> `[See more times]`

**After someone clicks:**
> ✅ Booked! A calendar invite has been sent to both of you for Thu Jun 5 at 12:00 PM ET with a Teams meeting link.

**Auto-book (nobody clicked within deadline):**
> 📅 We went ahead and scheduled a time for you: Mon Jun 9 at 1:00 PM ET. Calendar invite sent — check your Outlook!

**Fallback (calendar access failed):**
> 📅 We couldn't access calendars right now — find a time that works and grab 15 minutes for a coffee chat!

---

## Troubleshooting

| Error | Likely cause | Fix |
|---|---|---|
| `AuthenticationError` on startup | Wrong credential values in `.env` | Double-check all three values |
| `Unauthorized` when reading calendars | Admin consent not granted | IT clicks "Grant admin consent" in Azure portal → API permissions |
| `User not found` for a specific person | No Microsoft 365 account for that user | Confirm they have an active M365 account |
| No slots found, always falls back | Both calendars fully booked for 3 weeks | Expected — fallback message sent automatically |
| `OnlineMeetings.ReadWrite` error | Teams permission missing | IT confirms all 4 permissions were added, not just the Calendar ones |
| Credentials stop working after ~24 months | Client secret expired | IT creates a new secret, developer updates `AZURE_CLIENT_SECRET` in `.env` |

---

## Credentials Reference

| Variable | Where to find it | Who provides it |
|---|---|---|
| `AZURE_TENANT_ID` | Azure portal → App registrations → Overview → Directory (tenant) ID | IT |
| `AZURE_CLIENT_ID` | Azure portal → App registrations → Overview → Application (client) ID | IT |
| `AZURE_CLIENT_SECRET` | Azure portal → App registrations → Certificates & secrets | IT |
| `CALENDAR_ENABLED` | `.env` on the server | Developer |

---

*Related: [PRODUCTION.md](PRODUCTION.md) — general deployment guide*
