# Watercooler — User Manual

Watercooler is a Slack app that pairs DocMe360 team members for casual 15-minute virtual coffees. Every few weeks it runs a round, creates the pairs, and handles the scheduling — all without leaving Slack.

All commands start with `/watercooler` typed in any Slack message field.

---

## How to Run a Slash Command (read this first!)

Watercooler is controlled with Slack **slash commands** — special messages that start with `/`. A few things to know so they work on the first try:

**✅ The right way:**

1. Click into the message box (any channel or DM — it doesn't matter which).
2. **Type the command as plain text**, starting with the `/`:  `/watercooler status`
3. As soon as you start typing `/water`, Slack shows a **popup above the message box** with the Watercooler command. That popup is how you know Slack sees it as a command.
4. Hit Enter. The response appears with an "*Only visible to you*" note — nobody else in the channel sees your command or the reply.

**❌ The most common mistake — code formatting:**

If the command shows up **red and monospaced** in your message box (like `this`), Slack treats it as regular text and will just post it as a message instead of running it. This usually happens when:

- You clicked the `</>` code button (or code block button) in the formatting toolbar before typing
- You **copy-pasted the command from a document** (including this one!) and the formatting came along for the ride

**The fix:** delete it and retype the command by hand. If you pasted it, paste with `Cmd/Ctrl+Shift+V` (paste as plain text) — or just type it; they're short.

**Quick self-check before hitting Enter:** did the Watercooler popup appear above the message box? If yes, it'll run. If no popup appeared, Slack is about to send it as a plain message.

---

## For Participants

### Joining

There are two ways to join, depending on how your workspace is set up:

**Option 1 — Join the channel** *(if channel enrollment is on)*

Just join `#virtual-coffee`. You're automatically enrolled and get a welcome DM. This is the easiest way — no commands to remember.

**Option 2 — Slash command**

```
/watercooler join
```

Opts you in to matching. You'll be included starting with the next round. If you've left before, this re-activates your account. This always works, regardless of how enrollment is configured.

> **Already in the channel but want to stop being matched (lurk mode)?** Run `/watercooler leave` while staying in `#virtual-coffee` — you keep seeing the channel but won't be paired. Note: if an admin runs a channel sync, you may be re-enrolled, so `/watercooler pause` is the more durable way to sit out.

---

### Checking Your Status

```
/watercooler status
```

Shows whether you are:
- **Active** — in the queue for the next round
- **Paused** — opted in but skipping the next round
- **Not participating** — not joined yet, or previously left

---

### Pausing

```
/watercooler pause
```

Skips you for the next round without removing you from Watercooler. Useful for vacations, busy periods, or if you just need a break. You stay opted in and can come back any time.

---

### Resuming After a Pause

```
/watercooler resume
```

Puts you back in the queue. You'll be included in the next round that runs.

---

### Leaving

```
/watercooler leave
```

Opts you out entirely. You won't receive any further intros or messages. You can rejoin at any time with `/watercooler join`.

If channel enrollment is on, **leaving `#virtual-coffee` also opts you out** — same effect as this command.

---

### What Happens During a Round

When a round runs, Watercooler will send you a group DM with your match(es). Here's what to expect after that:

#### 1. Slot suggestions

Shortly after the intro DM, the bot posts a message with meeting time options based on everyone's Outlook calendars. Each option shows a time and timezone abbreviation (e.g. `Mon Jun 9, 2:00 – 2:30 PM CDT`). Click any button to book that slot.

#### 2. Booking confirmation

After you pick a slot, the bot replaces the buttons with a confirmation showing the time and a **Join Teams Meeting** link. A calendar invite is also sent to all participants via Outlook.

#### 3. Rescheduling

If you need to change the time, click the **Reschedule** button on the confirmation message — or just type `/watercooler reschedule` from anywhere and the bot will find your meeting for you, so you don't have to scroll back through the DM to find the button.

Either way, you'll get fresh time options with more variety than the original suggestion — spanning later today through next week, not just a few days out.

> **Rescheduling is private until you book.** The new time options are only visible to you — your match isn't notified that you're looking. They find out when you actually pick a new time, at which point everyone gets the updated confirmation and calendar invite. Until then, the existing meeting stays on both calendars exactly as it was.

Once you pick a new slot, the old calendar event is automatically removed and a new one is created.

> `/watercooler reschedule` works for the whole round — whether you already booked a time or never picked one at all. If it says you don't have a match but you know you do, ask an admin to run `resend-suggestions` (see the admin section below).

#### 4. After the meeting

Once your meeting time has passed, the bot will send a short follow-up in the group DM asking how it went. You'll see three options:

- **It was great** — logs positive feedback
- **It was fine** — logs neutral feedback
- **Snooze me for a bit** — pauses you from the next round automatically

Responding is optional but helps improve future rounds.

---

## FAQ — How Watercooler Works at DocMe360

*Answers reflect how our workspace is configured.*

**How do I join?**
Just join `#virtual-coffee`. You'll get a welcome DM from the bot confirming you're in — that's it.

**How often will I get matched?**
Every **3 weeks**, on **Monday mornings** (around 9 AM Eastern). Watch for a group DM from Watercooler introducing you to your match.

**How long are the meetings?**
**15 minutes**, over a Teams call. Casual — it's a coffee chat, not a meeting with an agenda.

**What if neither of us picks a time?**
If nobody clicks a time slot within about **2.5 days**, Watercooler automatically books the best available slot from your calendars and sends the invite. You can always hit 🔄 Reschedule if it picked badly.

**Can I change the meeting time after it's booked?**
Yes — click **🔄 Reschedule** on the booking confirmation in your match DM, or type `/watercooler reschedule` from anywhere if you can't find that message. Fresh time options appear (a wider spread than the original — later today through next week), pick one, and the old calendar event is replaced automatically. (Reschedule through the bot, not by editing the Outlook event — the bot won't know about changes made directly in Outlook.)

**Will my match know I'm trying to reschedule?**
Not until you actually book a new time. The time options are shown only to you — nothing is posted in the shared DM while you're looking. Your match is notified at the moment you pick a new slot, when the updated confirmation and calendar invite go out. If you change your mind and don't pick anything, they never know, and the original meeting stays exactly as it was.

**I can't find the Reschedule button — the DM has a lot of messages in it.**
Just run `/watercooler reschedule` — it finds your match automatically and shows fresh time options, no scrolling required. Works whether or not you've already booked a time.

**We never picked a time and the buttons are buried. Can we still get options?**
Yes — `/watercooler reschedule` works for the whole round, even if you never booked anything. It'll show a fresh set of times privately.

**My match declined, or the meeting time passed and we never actually met. Can we still fix it?**
Yes. `/watercooler reschedule` works for your **whole 3-week round**, no matter what state things are in — declined, never booked, or already marked "completed" because the scheduled time came and went. (The bot marks a match complete when the meeting time passes; it has no way to know whether you actually met.) Just run the command any time before the next round and pick a new time.

**What if my match declines the calendar invite?**
The bot notices (within about 10 minutes) and posts a note in your match DM with a 🔄 Reschedule button, so you can pick a time that works instead of waiting on a meeting that won't happen.

**Will I get matched with the same person again?**
Not for a while — Watercooler remembers your past matches and won't re-pair you with the same person within **4 rounds** (roughly 3 months).

**We have an odd number of people. What happens?**
One group becomes a **trio** instead of a pair. Same idea, one extra friend.

**I'm going on vacation / heads-down on a deadline. How do I sit out?**
Run `/watercooler pause` — you'll skip upcoming rounds until you run `/watercooler resume`. (You can also click **🤗 Snooze intros** on the post-meeting message, which does the same thing.)

**How do I leave entirely?**
Leave the `#virtual-coffee` channel — that unenrolls you. Rejoin the channel any time to get back in.

**What's the random fact in my calendar invite?**
A ☕ conversation starter, in case the chat needs a kickoff. Every match gets a different one.

**Do other people see my `/watercooler` commands?**
No. Commands and their responses are **only visible to you**, even when typed in a busy channel.

**We never ended up meeting. Is that a problem?**
No stress — after a couple of weeks the match is simply marked complete and you'll be in the next round as usual. If you want to skip the follow-up entirely, you can just ignore it.

**What timezone are the suggested times in?**
Each time button is labeled with its timezone (e.g. `2:00 PM EDT`). If you and your match are in the same timezone, times are shown in yours; otherwise they're shown in Eastern.

**Something's broken / I have an idea.**
Post in `#virtual-coffee` or reach out to **Dev Govindji** on Slack.

---

## For Admins

Admin commands are only available to users listed in the `ADMIN_USER_IDS` environment variable. All admin commands follow the pattern `/watercooler admin <subcommand>`.

Typing `/watercooler admin` with no subcommand prints the full command list.

---

### Running Rounds

#### Preview without sending anything

```
/watercooler admin dry-run
```

Shows who would be matched and how groups would be formed. No DMs are sent, no DB records are created. Use this to sanity-check before a real run.

#### Run with a test disclaimer

```
/watercooler admin test-run
```

Runs the full matching flow — creates records, sends DMs, posts slot buttons — but every message includes a `🧪 test` disclaimer so participants know it's not real. Useful for end-to-end testing.

#### Run for real

```
/watercooler admin run
```

Runs the full matching round. Creates match records, opens group DMs, sends intro messages, and triggers calendar slot suggestions for all matches.

---

### Monitoring

#### Participant counts

```
/watercooler admin summary
```

Quick overview: how many active participants, how many paused, how many excluded.

#### List all active participants

```
/watercooler admin participants
```

Full list of everyone currently in the matching pool.

#### List paused participants

```
/watercooler admin paused
```

Everyone who is opted in but currently paused.

#### Recent rounds

```
/watercooler admin recent-rounds
```

Shows the last few rounds with dates and status.

#### Current settings

```
/watercooler admin settings
```

Displays all configuration values: group size, cadence, booking deadline, calendar timezone, and more.

---

### Configuration

#### Group size

```
/watercooler admin set group-size <n>
```

Sets how many people are in each match. `2` for pairs, `3` for trios.

#### Matching cadence

```
/watercooler admin set cadence weekly|biweekly|triweekly|monthly
```

How often rounds run.

#### Repeat avoidance window

```
/watercooler admin set avoid-repeat-rounds <n>
```

Watercooler avoids re-matching the same two people within the last `n` rounds. Default is `4`.

#### Announcement channel

```
/watercooler admin set channel <channel-id>
```

Sets the Slack channel where round-complete summaries are posted (e.g. `#virtual-coffee`). Use the channel's ID (found in channel settings), not its name.

#### Enrollment mode

```
/watercooler admin set enrollment manual|channel
```

Controls how people join Watercooler:

- **`manual`** (default) — people join only via `/watercooler join`.
- **`channel`** — joining the intro channel (`#virtual-coffee`) automatically enrolls people and sends them a welcome DM; leaving the channel opts them out.

Channel mode requires an intro channel to be set first (above), and the bot must be a member of that channel. After turning it on, run `sync-channel` (below) once to enroll everyone already in the channel.

---

### Managing Participants

#### Exclude a user

```
/watercooler admin exclude @user
```

Prevents a user from being matched, even if they try to join. Use for contractors, accounts that should never be included, or anyone who should be permanently excluded.

#### Lift an exclusion

```
/watercooler admin include @user
```

Removes a previous exclusion. The user can then join normally with `/watercooler join`.

#### Refresh display names

```
/watercooler admin refresh-names
```

Re-fetches every participant's real name from their Slack profile and updates the DB. Run this if names look wrong in match intros or summaries.

#### Sync the channel (enrollment backfill)

```
/watercooler admin sync-channel
```

Only used in **channel** enrollment mode. Channel join/leave events only catch *future* changes, so this is a one-time backfill that enrolls everyone **already** sitting in `#virtual-coffee`. Run it once right after switching to channel mode.

It reports a summary (enrolled / reactivated / already active / skipped) and a **drift list** — anyone active in the system who is *not* in the channel (e.g. people who joined by command earlier). It only reports drift; it never removes anyone. Safe to run repeatedly.

---

### Calendar & Azure

#### Check the Microsoft Graph connection

```
/watercooler admin calendar-status
```

Verifies that the Azure credentials are configured and that the app can reach the Microsoft Graph API. Use this to diagnose issues with slot suggestions or calendar event creation.

---

### Workflow Recovery

These commands exist so admins can manually drive the matching workflow if something goes wrong — a Graph API error, a missed DM, a slot that never got suggested, etc. Run `/watercooler admin list-matches` first to get the match and round IDs you need.

#### See matches and their state

```
/watercooler admin list-matches
/watercooler admin list-matches <roundId>
/watercooler admin list-matches last <n>
```

Shows rounds with every match, participant names, and a workflow state indicator. Without arguments, shows the last two rounds. Pass a round ID to look up any historic round (including cancelled ones), or `last <n>` to see up to the last 10 rounds at once.

| Symbol | Meaning |
|--------|---------|
| ✅ | Feedback received — fully complete |
| 📅 | Calendar event booked |
| ⏳ | Slot suggestions sent, waiting for a pick |
| 📨 | Intro DM sent, no slot suggestions yet |
| ⚠️ | No DM channel — intro may not have sent |

#### Force-book a meeting

```
/watercooler admin force-book <matchId>
/watercooler admin force-book
```

Books the best available slot for a specific match immediately, without waiting for anyone to click a button. Useful when slot suggestions were sent but nobody responded before the deadline.

Running without a match ID books **all** unbooked matches from completed rounds at once.

#### Send the post-meeting follow-up

```
/watercooler admin send-completion <matchId>
/watercooler admin send-completion
```

Sends the post-meeting feedback message to a specific match. If all matches in a round are then complete, also posts the round-complete summary to the announcement channel.

Running without a match ID sends to all matches that qualify.

#### Re-send slot suggestions

```
/watercooler admin resend-suggestions <matchId>
```

Re-posts the calendar slot buttons to a match DM. Use when the original suggestion message was lost, expired, or never sent. Always requires a match ID.

#### Cancel a round

```
/watercooler admin cancel-round <roundId>
/watercooler admin cancel-round
```

Cancels an entire round. For each match in the round:
- Deletes the calendar event from Outlook (if one was created)
- Replaces any active slot buttons with a cancellation notice
- Posts a message to the group DM letting participants know

Running without a round ID targets the most recent non-cancelled round.

Use this before starting a new round if the previous one went out incorrectly, or if the round needs to be voided for any reason.
