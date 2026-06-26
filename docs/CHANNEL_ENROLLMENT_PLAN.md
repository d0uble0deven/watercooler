# Channel-Based Auto-Enrollment — Implementation Plan

> **Goal:** Joining `#virtual-coffee` enrolls you in Watercooler. Leaving the channel opts you out. Slash commands remain as overrides. The all-hands pitch becomes: *"Join #virtual-coffee and you're in."*

## Decided Behavior

| Decision | Choice |
|---|---|
| Enrollment channel | `#virtual-coffee` — reuses the existing `intro_channel_id` setting |
| Leave channel | Opted out — identical to `/watercooler leave` |
| Slash commands | Remain as overrides; last action wins |
| Lurk mode | Allowed — `/watercooler leave` while staying in the channel means you watch but aren't matched |
| Welcome DM | Sent on every auto-enroll so nobody is surprised |
| Filtering | Bots and guest accounts are never enrolled; admin exclusion list still applies |
| Feature toggle | New setting `enrollment_mode: manual \| channel`, defaults to `manual` (current behavior) |

---

## Step 0 — Slack App Configuration (manual, no code)

All of this happens in the Slack app dashboard at **https://api.slack.com/apps** → click your **Watercooler** app. No code or terminal needed. Takes about 5 minutes.

### 0a — Add the `channels:read` bot scope

This scope lets the bot list a channel's members (for the one-time backfill in Step 4) and confirm channel membership.

1. In the left sidebar, click **OAuth & Permissions**.
2. Scroll down to **Scopes → Bot Token Scopes**.
3. Click **Add an OAuth Scope**.
4. Type and select **`channels:read`**.

> You'll see a yellow banner at the top saying the app needs to be reinstalled — that's expected. Do it in step 0c, after adding the events, so you only reinstall once.

### 0b — Subscribe to the two channel events

These are what tell the app when someone joins or leaves the channel.

1. In the left sidebar, click **Event Subscriptions**.
2. Make sure the **Enable Events** toggle at the top is **On**.
   - Because the app runs in **Socket Mode**, there is **no Request URL to fill in** — the field is hidden or marked as handled by Socket Mode. (If it's demanding a Request URL, Socket Mode isn't enabled — but it already is, since your slash commands work.)
3. Expand the **Subscribe to bot events** section (not "workspace events").
4. Click **Add Bot User Event** and add each of these:
   - **`member_joined_channel`**
   - **`member_left_channel`**
5. Click **Save Changes** (green button, bottom-right). Easy to miss — the events won't take effect without it.

### 0c — Reinstall the app

Adding a scope requires a reinstall to take effect.

1. Go back to **OAuth & Permissions** (or click the yellow "reinstall" banner if it's showing).
2. Click **Reinstall to Workspace** → review the permissions → **Allow**.

> ✅ **Your `.env` does not change.** Reinstalling to the same workspace keeps the same bot token (`xoxb-...`), so there's nothing to update on the VM. (If you ever *rotate* the token deliberately, that's the only time you'd update `.env` and restart the app.)

### 0d — Make sure the bot is in `#virtual-coffee`

**This is the easy-to-forget one.** Slack only sends `member_joined_channel` / `member_left_channel` events for a channel **the bot itself is a member of**. If the bot isn't in `#virtual-coffee`, it will never hear about anyone joining.

In Slack, go to `#virtual-coffee` and type:
```
/invite @Watercooler
```
(If it's already in the channel — which it likely is, since it posts round summaries there — Slack will just say it's already a member. No harm.)

> ⚠️ `#virtual-coffee` must be a **public** channel for `channels:read`. If it's ever made private, you'd swap the scope to `groups:read` — but the bot-membership requirement is the same either way.

### "It's the same channel as the intro channel — do I need anything extra?"

**No new settings, and that's by design.** The enrollment feature reuses the existing **intro channel** setting (`intro_channel_id`) — the same `#virtual-coffee` where round summaries already post. So:

- ✅ **Nothing to configure twice** — one channel does both jobs (announcements + enrollment).
- ✅ **No new "enrollment channel" setting** — Step 3's code checks incoming events against `intro_channel_id`.

The only two things that must be true (both covered above):
1. `intro_channel_id` is actually set — confirm with `/watercooler admin settings`; if blank, run `/watercooler admin set channel <channel-id>`.
2. The bot is a member of that channel (step 0d).

### Verify Step 0 worked

The events won't *do* anything until the code in Steps 1–3 is built — but you can confirm Slack is delivering them now. With the app running, watch the logs (`pm2 logs watercooler`), then have someone join `#virtual-coffee`. Temporarily add a one-line `app.event('member_joined_channel', ...)` logger, or just trust the dashboard: if both events show under **Event Subscriptions → Subscribe to bot events** and **Save Changes** was clicked, delivery is wired up.

---

## Step 1 — DB Migration + Settings Toggle

**Changes:**
- Migration: `ALTER TABLE settings ADD COLUMN enrollment_mode TEXT NOT NULL DEFAULT 'manual'`
- Migration: `ALTER TABLE users ADD COLUMN enrolled_via TEXT` — `'command' | 'channel' | 'sync'`, for debugging and future analytics
- `/watercooler admin set enrollment manual|channel` in `set.js`
  - Guard: refuse to set `channel` if `intro_channel_id` is not configured (the feature has no channel to watch)
- Show `enrollment_mode` in `/watercooler admin settings` output

**Files:** `src/db/init.js`, `src/commands/admin/set.js`, `src/commands/admin/show-settings.js`

**Verify:** run migration, flip the setting via Slack, confirm it shows in settings output. Mode is `channel` but nothing listens yet — no behavior change.

---

## Step 2 — Enrollment Library (shared logic)

New `src/lib/enrollment.js` so the event handlers (Step 3) and backfill command (Step 4) share one code path:

**`enrollUser(client, slackUserId, source)`** returns a status string:
- `skipped_excluded` — admin exclusion list wins over everything
- `skipped_bot` / `skipped_guest` — via `users.info` (`is_bot`, `is_restricted`, `is_ultra_restricted`, `deleted`)
- `already_active` — no-op, no DM
- `enrolled` — new user created (real-name resolution, same as `join.js`)
- `reactivated` — previously left/inactive user re-activated
- Sends the welcome DM only on `enrolled` / `reactivated`
- Stamps `enrolled_via` with the source

**`unenrollUser(slackUserId)`** — sets `is_active = 0` if the user exists; no DM (they just left the channel, messaging them would be noise)

**Welcome DM copy (draft):**
> ☕ *Welcome to Watercooler!* You joined #virtual-coffee, so you're now in the rotation — every few weeks you'll be matched with a teammate for a casual 15-minute coffee chat.
> No action needed. To sit out a round use `/watercooler pause`; to opt out entirely just leave the channel.

**Note:** `join.js` keeps its own flow (it has command-specific responses). The shared logic lives in the lib; `join.js` can be refactored to use it in a later cleanup if desired — not part of this plan.

**Files:** `src/lib/enrollment.js` (new)

**Verify:** smoke-test the lib directly with a mock client — all six status paths.

---

## Step 3 — Channel Event Handlers

**Changes in `src/app.js` (or a new `src/commands/events/channelMembership.js`):**

- `app.event('member_joined_channel')`:
  1. Ignore unless `settings.enrollment_mode === 'channel'`
  2. Ignore unless `event.channel === settings.intro_channel_id`
  3. Ignore the bot's own user ID (it gets an event when it joins the channel)
  4. Call `enrollUser(client, event.user, 'channel')`
- `app.event('member_left_channel')`:
  1. Same mode + channel + bot guards
  2. Call `unenrollUser(event.user)`

**Edge cases handled by design:**
- Kicked vs. left voluntarily — Slack fires the same event; both mean opted out (consistent with the decision)
- Someone joins the channel before the app was deployed/online — caught by Step 4's backfill
- `enrollment_mode = 'manual'` — events arrive but are ignored; zero behavior change until the flag flips

**Files:** `src/app.js`, possibly `src/commands/events/channelMembership.js` (new)

**Verify:** with mode set to `channel` in a test workspace/channel: join → welcome DM arrives + user active in DB; leave → user inactive; `/watercooler status` reflects both.

---

## Step 4 — Backfill Admin Command

**`/watercooler admin sync-channel`**

1. Guard: `enrollment_mode` must be `channel`, `intro_channel_id` must be set
2. Fetch all members of `#virtual-coffee` via `conversations.members` (paginated, 200/page)
3. Run each through `enrollUser(client, id, 'sync')`
4. Report a summary:
   > ✅ Channel sync complete for #virtual-coffee
   > • 38 enrolled (welcome DMs sent) • 4 reactivated • 5 already active
   > • 2 skipped (bots) • 1 skipped (guest) • 1 skipped (excluded)
5. **Drift report (report-only, never auto-acts):** list users who are active in the DB but *not* in the channel — e.g. people who joined via command before this feature existed. Admin decides what to do; the command never mass-deactivates.

**Files:** `src/commands/admin/sync-channel.js` (new), `src/commands/admin/index.js` (route + help text)

**Verify:** run against the real channel with a small test group; counts in the summary match reality; second run reports mostly `already active`.

---

## Step 5 — Tests

New `scripts/test-enrollment.js` + `test:enrollment` npm script (added to `test:all`):

- **`enrollUser` paths:** excluded → skipped; bot → skipped; guest → skipped; new → enrolled + DM; inactive → reactivated + DM; active → no-op, no DM
- **`unenrollUser`:** active → inactive; unknown user → no crash
- **Event handler guards:** wrong channel → ignored; `enrollment_mode = 'manual'` → ignored; bot's own ID → ignored
- **`sync-channel`:** mock `conversations.members` with a mixed roster, verify summary counts and that DMs only went to newly enrolled/reactivated
- **Lurk mode:** `/watercooler leave` then re-run sync → user stays opted out only if sync respects... ⚠️ **design note:** sync would re-enroll a lurker. Resolution: `enrollUser` treats `is_active = 0` users who previously left via *command* the same as anyone else — re-enrolled. Lurk mode is achieved by leaving via command *after* enrollment and only persists until the next sync. Document this in the manual; event-driven enrollment (the normal path) never re-enrolls lurkers because no join event fires for someone already in the channel.

**Files:** `scripts/test-enrollment.js` (new), `package.json`

---

## Step 6 — Documentation

- **README.md** — new scope in the Slack setup list, `sync-channel` + `set enrollment` in the admin command tables, event subscriptions noted
- **USER_MANUAL.md** — "Joining" section gains the channel path as the primary method; lurk-mode caveat documented; admin section gains `sync-channel`
- **DONUT_COMPARISON.md** — "Auto-enroll" row flips to ✅; lurk mode row flips to ✅
- **PRODUCTION.md** — scope + event subscription setup steps

---

## Rollout Sequence (launch day)

1. Step 0 Slack config done in advance; deploy code with `enrollment_mode = 'manual'` (nothing changes)
2. Flip: `/watercooler admin set enrollment channel`
3. Backfill: `/watercooler admin sync-channel` — existing channel members enrolled, welcome DMs go out
4. All-hands: **"Join #virtual-coffee and you're in"**
5. New joins enroll in real time from here on

## Rollback

`/watercooler admin set enrollment manual` — events are ignored again instantly. No data loss; everyone enrolled stays enrolled, manual commands still work.

---

*Each step lands separately with its own verification before moving to the next, per the standard workflow.*
