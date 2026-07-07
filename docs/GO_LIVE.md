# Watercooler — Go Live Runbook

The final stretch: verify the entire workflow end-to-end with real teammates in a
**test channel**, then flip one setting to launch in `#virtual-coffee`.

This doc assumes deployment is already done. For reference:
- [AZURE_DEPLOYMENT.md](AZURE_DEPLOYMENT.md) — VM hosting (done)
- [PRODUCTION.md](PRODUCTION.md) — Slack app setup, scopes, tokens (done)
- [CHANNEL_ENROLLMENT_PLAN.md](CHANNEL_ENROLLMENT_PLAN.md) — enrollment feature design (built)
- [USER_MANUAL.md](USER_MANUAL.md) — every command explained

---

## Already Done ✓

- [x] App deployed to the Azure VM, running under PM2, daily backups
- [x] Slack scopes + `member_joined_channel` / `member_left_channel` events + reinstall
- [x] `ADMIN_USER_IDS` configured
- [x] Settings updated (cadence `triweekly`, calendar enabled, 15-min meetings)

> Sanity-check any time with `/watercooler admin settings`.

---

## Phase 1 — Full Workflow Test (test channel)

**Goal:** every tester gets matched, books a real Teams meeting, reschedules,
receives the follow-up, and clicks feedback — all with 🧪 test disclaimers, all
without touching `#virtual-coffee`.

> Testers should be real teammates who'll be in `#virtual-coffee` at launch —
> their enrollment carries over, so there's nothing to clean up afterwards.
> **No `db:reset` needed.**

### 1. Set up the test channel

1. Create a **public** test channel (e.g. `#watercooler-test`)
2. Invite the bot: `/invite @Watercooler` — required or join/leave events won't fire
3. Point the app at it:
   ```
   /watercooler admin set channel <TEST_CHANNEL_ID>
   /watercooler admin set enrollment channel
   ```
   (Channel ID: channel name → scroll to bottom of the About tab.)

### 2. Enroll the testers

- Have testers **join the test channel** → each should get the ☕ welcome DM instantly
- Anyone already in the channel before enrollment was flipped: run
  `/watercooler admin sync-channel` to backfill them
- Verify the roster: `/watercooler admin participants`

### 3. Run a test round

```
/watercooler admin test-run
```

Same as a real round — real DMs, real slot buttons, real calendar invites and
Teams links — but every message carries a 🧪 test disclaimer.

Each match group should then:

- [ ] Receive the intro DM + suggested meeting times (with timezone in each button)
- [ ] **Click a slot** → confirmation message + Outlook invite email (check the
      ☕ conversation-starter fun fact in the email body)
- [ ] At least one group: click **🔄 Reschedule** → new slots posted → pick one →
      old calendar event deleted, new one created
- [ ] Join the Teams meeting from the invite (or just confirm the link opens)

### 4. Test the follow-up workflow

The post-meeting feedback message fires automatically once the booked meeting
time has passed (the scheduler checks every minute). To test it **immediately**
without waiting:

```
/watercooler admin send-completion
```

Then verify:

- [ ] Each match DM gets the "How was your Watercooler intro?" message
- [ ] Feedback buttons work (👍 / 👎 / 🤗 Snooze — note Snooze pauses that person;
      un-pause testers afterwards with `/watercooler resume`)
- [ ] Once **all** matches in the round are complete, the 🎉 round-summary posts
      to the test channel

### 5. Optional extras worth exercising

- `/watercooler admin list-matches` — see match IDs and workflow states
- `/watercooler admin cancel-round` on a spare test round — DMs get cancellation
  notices, calendar events are deleted
- `/watercooler admin force-book <matchId>` — books without anyone clicking
- Leave the test channel → confirm you're unenrolled (`/watercooler status`),
  rejoin → re-enrolled

---

## Phase 2 — Go Live

Once Phase 1 all checks out, launch is four commands and an announcement:

1. **Invite the bot to `#virtual-coffee`**: `/invite @Watercooler`
2. **Switch the channel** — this is the actual "go live" moment:
   ```
   /watercooler admin set channel <VIRTUAL_COFFEE_CHANNEL_ID>
   ```
   Enrollment events and announcements now follow `#virtual-coffee`; the test
   channel is instantly inert (archive it whenever).
3. **Verify**: `/watercooler admin settings` — channel, enrollment `channel`,
   cadence `triweekly`, calendar enabled, 15 min
4. **Backfill everyone already in the channel**:
   ```
   /watercooler admin sync-channel
   ```
   Existing members get enrolled + welcome DMs. Testers show as "already active"
   (no duplicate DMs). Review the drift list if one prints.
5. **Confirm the roster**: `/watercooler admin participants`
6. **Preview the first round**: `/watercooler admin dry-run`
7. **Launch the first round** (when ready — e.g. right after the all-hands):
   ```
   /watercooler admin run
   ```

From here on, it runs itself: new channel joiners are auto-enrolled and queued
for the next round; the scheduler fires a round every 3 weeks.

---

## Good-to-Know Caveats

- **Kick off the first real round manually.** Test rounds count as completed
  rounds, so the triweekly scheduler thinks a round "just ran" and will wait
  ~3 weeks. `/watercooler admin run` (step 7) bypasses that; the schedule takes
  over afterwards.
- **Test pairings count toward repeat-avoidance.** Whoever you test-matched with
  won't be re-paired with you for the next 4 rounds. With ~50 people this is a
  non-issue.
- **Joining the channel never triggers a round.** New joiners are enrolled and
  queued; matching only happens on the schedule or via `admin run`.
- **Snoozed testers stay snoozed.** Anyone who clicked 🤗 during testing sits
  out the next round — have them run `/watercooler resume` before launch.
