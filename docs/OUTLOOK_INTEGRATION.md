# Watercooler — Outlook Calendar Integration

Setup guide for connecting Watercooler to Microsoft 365 so it can read calendars, suggest meeting times, and auto-create Teams invites.

**This feature is built but disabled by default.** Neither section needs to be done until you are ready to turn it on. The app runs exactly as before until `CALENDAR_ENABLED=true` is set.

---

## How It Works (Overview)

After two people are matched, instead of just sending an intro DM, the app will:

1. Read both people's Outlook calendars for the next 3 weeks
2. Find overlapping 15-minute free slots within each person's business hours
3. Post 3 suggested times as clickable buttons in the group DM
4. When one person clicks a time — create a calendar invite + Teams meeting link for both
5. If nobody clicks within the configured deadline — auto-book the first available slot and send the invite automatically

**Fallback:** if calendar access fails for any reason, the regular intro DM is sent and people schedule it themselves. The round never fails because of a calendar issue.

---

## Who Does What

| Task | Who |
|---|---|
| Part 1 — Azure AD app registration | IT / Microsoft admin |
| Part 2 — Add credentials to the server | Developer |
| Part 3 — Enable and test | Developer + IT (if issues) |

---

## Part 1 — Azure AD App Registration (IT)

> **Time required:** ~15 minutes
> **Where:** https://portal.azure.com

### Step 1 — Sign in to Azure Portal

Go to **https://portal.azure.com** and sign in with your Microsoft 365 admin account.

---

### Step 2 — Register a New App

1. In the search bar at the top, search for **"App registrations"** and click it
2. Click **"+ New registration"**
3. Fill in:
   - **Name:** `Watercooler`
   - **Supported account types:** `Accounts in this organizational directory only (DocMe360 only - Single tenant)`
   - **Redirect URI:** leave blank
4. Click **Register**

You'll land on the app's overview page. **Copy and save these two values** — the developer will need them:
- **Application (client) ID** → this is `AZURE_CLIENT_ID`
- **Directory (tenant) ID** → this is `AZURE_TENANT_ID`

---

### Step 3 — Add API Permissions

1. In the left sidebar, click **"API permissions"**
2. Click **"+ Add a permission"**
3. Click **"Microsoft Graph"**
4. Click **"Application permissions"** (not Delegated — this is important)
5. Search for and add each of these permissions:

| Permission | What it allows |
|---|---|
| `Calendars.Read` | Read employees' calendars to find free slots |
| `Calendars.ReadWrite` | Create calendar invites on employees' calendars |
| `OnlineMeetings.ReadWrite` | Generate Teams meeting links |
| `User.Read.All` | Look up employees' email addresses and timezones |

6. Click **"Add permissions"**
7. Click **"Grant admin consent for DocMe360"** (the blue button) → click **Yes** to confirm

> ⚠️ The "Grant admin consent" step is required. Without it the permissions are requested but not active.

---

### Step 4 — Create a Client Secret

1. In the left sidebar, click **"Certificates & secrets"**
2. Click **"+ New client secret"**
3. Description: `Watercooler app secret`
4. Expiry: **24 months** (or your org's standard)
5. Click **Add**
6. **Immediately copy the secret Value** (the long string in the Value column) — this is `AZURE_CLIENT_SECRET`

> ⚠️ This value is only shown once. If you navigate away without copying it, you'll need to delete it and create a new one.

---

### Step 5 — Share Credentials with the Developer

Send the developer these three values securely (do not send via Slack or email in plain text — use a password manager or secure note):

```
AZURE_TENANT_ID=        (Directory ID from Step 2)
AZURE_CLIENT_ID=        (Application ID from Step 2)
AZURE_CLIENT_SECRET=    (Secret value from Step 4)
```

**IT's work is done.** No ongoing involvement needed unless the secret expires or permissions need to change.

---

## Part 2 — Developer Setup

### Step 1 — Add credentials to `.env`

Open `.env` and add the three values IT provided:

```env
# Microsoft Graph — from Azure AD app registration
AZURE_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_SECRET=your-secret-value-here

# Calendar feature — keep false until ready to test
CALENDAR_ENABLED=false
```

---

### Step 2 — Restart the server

```bash
npm start
```

You should see a new line in the startup output:

```
[Calendar] Microsoft Graph client initialised (calendar disabled — set CALENDAR_ENABLED=true to enable)
```

If you see an auth error instead, double-check the three credential values and that IT clicked "Grant admin consent" in Step 3 above.

---

### Step 3 — Verify the connection (before enabling)

Run this command in Slack to confirm the Graph API credentials are working without turning the feature on:

```
/watercooler admin calendar-status
```

Expected response:
```
✅ Microsoft Graph connected — calendar integration is ready.
   CALENDAR_ENABLED is currently false. Run:
   /watercooler admin set calendar-enabled true
   to activate it.
```

If it returns an error, see the Troubleshooting section at the bottom.

---

### Step 4 — Configure settings

These all have sensible defaults. Adjust as needed:

```
/watercooler admin set calendar-enabled true
/watercooler admin set meeting-duration 15
/watercooler admin set booking-deadline 2.5
```

| Setting | Default | Notes |
|---|---|---|
| `calendar-enabled` | `false` | Master on/off switch |
| `meeting-duration` | `15` | Minutes — 15 is the plan |
| `booking-deadline` | `2.5` | Days before auto-book fires. Supports decimals — 2.5 = 60 hours |

> **How `booking-deadline` works in practice:**
> If matches go out Monday at 10 AM and deadline is `2.5`, the auto-book fires Wednesday at 10 PM.
> Use `2.0` for Wednesday 10 AM, `1.5` for Tuesday 10 PM, etc.

All settings are shown in `/watercooler admin settings` alongside the existing ones.

---

### Step 5 — Test with a dry run

Run a dry run first — this will test the calendar lookup without sending any DMs or creating any invites:

```
/watercooler admin dry-run
```

The preview will now show whether calendar slots were found for each pair, alongside the match preview.

---

### Step 6 — Test with a real run (small group)

Before rolling out to everyone, test with just yourself and one other person:

1. Make sure only 2 people are joined (`/watercooler admin participants`)
2. Run `/watercooler admin run`
3. Check the group DM — you should see the intro message followed by 3 suggested time slots as buttons
4. Click one — verify the calendar invite and Teams link arrive in Outlook
5. Check `/watercooler admin recent-rounds` to confirm the booking status shows `confirmed`

---

## Part 3 — Business Hours Logic

The app determines valid slots per person based on their local timezone (read from their Microsoft 365 profile). A slot is only suggested if it falls within **9 AM – 5 PM in each person's own timezone**.

**Example — Alice in California (PT), Bob in Maine (ET):**
- A slot at 12:00 PM ET (9:00 AM PT) is valid for both ✅
- A slot at 8:00 AM ET (5:00 AM PT) is outside Alice's hours ❌
- A slot at 6:00 PM ET (3:00 PM PT) is outside Bob's hours ❌
- The practical overlap window is roughly **12:00 PM – 5:00 PM ET** (9:00 AM – 2:00 PM PT)

No configuration needed — timezone is read automatically from each user's Microsoft profile.

---

## Part 4 — What Employees See

### The matching DM

> 👋 Hi Alice and Bob! I've matched you for a Watercooler chat! ☕
>
> 📅 Here are some times you're both free — click one to book it:
>
> **Thu Jun 5 · 12:00–12:15 PM ET** &nbsp; `[Book this]`
> **Fri Jun 6 · 2:00–2:15 PM ET** &nbsp;&nbsp;&nbsp; `[Book this]`
> **Mon Jun 9 · 1:00–1:15 PM ET** &nbsp;&nbsp; `[Book this]`
>
> `[See more times]`

### After someone clicks

> ✅ Booked! A calendar invite has been sent to both of you for **Thu Jun 5 at 12:00 PM ET** with a Teams meeting link.

### Auto-book (if nobody clicks within the deadline)

> 📅 We went ahead and scheduled a time for you: **Mon Jun 9 at 1:00 PM ET**. Calendar invite sent — check your Outlook!

### If calendar access fails (fallback)

> 📅 We couldn't access calendars right now — find a time that works and grab 15 minutes for a coffee chat!

---

## Part 5 — Turning It Off

To disable calendar integration without removing the credentials:

```
/watercooler admin set calendar-enabled false
```

All future rounds will fall back to the regular intro DM. Existing bookings already made are not affected.

---

## Troubleshooting

| Error | Likely cause | Fix |
|---|---|---|
| `AuthenticationError` on startup | Wrong `AZURE_CLIENT_ID` or `AZURE_CLIENT_SECRET` | Double-check the values in `.env` |
| `Unauthorized` when reading calendars | Admin consent not granted | IT needs to click "Grant admin consent" in Azure portal (Part 1, Step 3) |
| `User not found` for a specific person | User's email not found in Microsoft 365 | Confirm the user has an active Microsoft 365 account |
| No slots found, always falls back | Calendars are fully booked for 3 weeks | Expected — fallback message is sent. Consider increasing look-ahead window |
| `OnlineMeetings.ReadWrite` permission error | Teams meeting creation failed | Confirm IT added all four permissions, not just the Calendar ones |
| Secret expired | Client secret passed its expiry date | IT creates a new secret in Azure portal, developer updates `AZURE_CLIENT_SECRET` in `.env` |

---

## Credentials Reference

| Variable | Where to find it | Who provides it |
|---|---|---|
| `AZURE_TENANT_ID` | Azure portal → App registrations → your app → Directory (tenant) ID | IT |
| `AZURE_CLIENT_ID` | Azure portal → App registrations → your app → Application (client) ID | IT |
| `AZURE_CLIENT_SECRET` | Azure portal → App registrations → your app → Certificates & secrets | IT |
| `CALENDAR_ENABLED` | Set in `.env` | Developer |

---

*Related: [docs/PRODUCTION.md](PRODUCTION.md) — general deployment guide*
