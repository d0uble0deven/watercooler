# Watercooler — User Manual

Watercooler is a Slack app that pairs DocMe360 team members for casual 15-minute virtual coffees. Every few weeks it runs a round, creates the pairs, and handles the scheduling — all without leaving Slack.

All commands start with `/watercooler` typed in any Slack message field.

---

## For Participants

### Joining

```
/watercooler join
```

Opts you in to matching. You'll be included starting with the next round. If you've left before, this re-activates your account.

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

---

### What Happens During a Round

When a round runs, Watercooler will send you a group DM with your match(es). Here's what to expect after that:

#### 1. Slot suggestions

Shortly after the intro DM, the bot posts a message with meeting time options based on everyone's Outlook calendars. Each option shows a time and timezone abbreviation (e.g. `Mon Jun 9, 2:00 – 2:30 PM CDT`). Click any button to book that slot.

#### 2. Booking confirmation

After you pick a slot, the bot replaces the buttons with a confirmation showing the time and a **Join Teams Meeting** link. A calendar invite is also sent to all participants via Outlook.

#### 3. Rescheduling

If you need to change the time, click the **Reschedule** button on the confirmation message. The bot will post fresh slot options in the same DM. Once you pick a new slot, the old calendar event is automatically removed and a new one is created.

> If you need to reschedule but don't see a Reschedule button, ask an admin to run `resend-suggestions` for your match (see the admin section below).

#### 4. After the meeting

Once your meeting time has passed, the bot will send a short follow-up in the group DM asking how it went. You'll see three options:

- **It was great** — logs positive feedback
- **It was fine** — logs neutral feedback
- **Snooze me for a bit** — pauses you from the next round automatically

Responding is optional but helps improve future rounds.

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
