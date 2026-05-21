# Watercooler vs. Donut — Feature Comparison

A breakdown of what our custom Watercooler app covers today vs. the full feature set of Donut (the leading Slack matching app), and a prioritised view of what we may want to add in the future.

---

## Core Matching

| Feature | Donut | Watercooler |
|---|---|---|
| Random pair/group matching | ✅ | ✅ |
| Repeat-pair avoidance | ✅ Tracks full history | ✅ Configurable window (default: 4 rounds) |
| Configurable group size | ✅ 2–8 people | ✅ 2–3 (pairs + 1 trio for odd counts) |
| Odd-number handling | ✅ | ✅ One trio automatically |
| Configurable cadence | ✅ Weekly / every 2 wks / every 4 wks | ✅ Weekly / biweekly / monthly |
| Scheduled auto-run | ✅ | ✅ Configurable day + time |
| Manual admin-triggered run | ✅ | ✅ `/watercooler admin run` |
| Dry-run preview before sending | ✅ | ✅ `/watercooler admin dry-run` |
| Smart matching (avoid people already in the same channels) | ✅ | ❌ Not built — purely random today |
| Cross-group matching (e.g. only match across departments) | ✅ Premium | ❌ Not built |
| Within-group matching (e.g. only match within a team) | ✅ Premium | ❌ Not built |
| Lottery intro type | ✅ | ❌ Not built |
| Custom one-off "next run" date | ✅ | ❌ Day + time only, no specific date override |
| Groups larger than 3 | ✅ Up to 8 | ❌ Max 3 today |

---

## User Controls

| Feature | Donut | Watercooler |
|---|---|---|
| Opt in to matching | ✅ Join channel | ✅ `/watercooler join` |
| Opt out of matching | ✅ Leave channel | ✅ `/watercooler leave` |
| Pause / skip rounds | ✅ Snooze up to 4 rounds | 🟡 Pause works but is indefinite — no round limit |
| Resume after pause | ✅ | ✅ `/watercooler resume` |
| Check own status | ✅ | ✅ `/watercooler status` |
| Snooze for a specific number of rounds | ✅ 1–4 rounds | ❌ Not built |
| Stay in channel but opt out of matching | ✅ Lurk mode | ❌ Not built |
| "Do not pair" with a specific person | ✅ | ❌ Not built |
| User profile / Favorite Things | ✅ | ❌ Not built |

---

## Admin Controls

| Feature | Donut | Watercooler |
|---|---|---|
| Admin-only command guard | ✅ | ✅ `ADMIN_USER_IDS` env var |
| View participant list | ✅ | ✅ `/watercooler admin participants` |
| View paused users | ✅ | ✅ `/watercooler admin paused` |
| Exclude a specific user | ✅ | ✅ `/watercooler admin exclude @user` |
| Lift an exclusion | ✅ | ✅ `/watercooler admin include @user` |
| View current settings | ✅ | ✅ `/watercooler admin settings` |
| Update settings | ✅ Web dashboard | 🟡 Slack commands only — no web dashboard |
| View round history | ✅ Dashboard + CSV | 🟡 Last 5 rounds via Slack command only |
| Participant count summary | ✅ | ✅ `/watercooler admin summary` |
| Pause matching for the whole team | ✅ | ❌ Not built |
| Skip just the next round | ✅ | ❌ Not built |
| Multi-channel support (multiple programs per workspace) | ✅ | ❌ Single program per workspace today |
| Web admin dashboard | ✅ donut.ai | ❌ Not built — Slack commands only |
| HRIS sync (BambooHR, Workday, etc.) | ✅ 50+ platforms | ❌ Not built |
| Automated group assignment from HRIS data | ✅ Premium | ❌ Not built |

---

## Scheduling & Calendar

| Feature | Donut | Watercooler |
|---|---|---|
| Automated matching on a schedule | ✅ | ✅ |
| Google Calendar integration | ✅ Free tier | ❌ Not built |
| Microsoft Outlook integration | ✅ | ❌ Not built |
| Zoom integration | ✅ Free tier | ❌ Not built |
| Google Meet / MS Teams integration | ✅ | ❌ Not built |
| Users schedule meeting themselves (default flow) | ✅ | ✅ Current behaviour |

---

## Engagement & Culture

| Feature | Donut | Watercooler |
|---|---|---|
| Intro DM sent to matched group | ✅ | ✅ |
| Channel announcement when round fires | ✅ | ✅ Posts to configured channel if set |
| Conversation starter prompts (on demand) | ✅ | ❌ Not built |
| Watercooler discussion topics posted to a channel | ✅ | ❌ Not built |
| Curated topic packs (New Managers, Interns, etc.) | ✅ | ❌ Not built |
| Post-meeting compliments / feedback | ✅ | ❌ Not built |
| Peer-to-peer recognition (Shoutouts + points) | ✅ Premium | ❌ Not built |
| Rewards store | ✅ Premium | ❌ Not built |
| Birthday & work anniversary celebrations | ✅ | ❌ Not built |

---

## Reporting & Analytics

| Feature | Donut | Watercooler |
|---|---|---|
| Participant counts (eligible / paused / excluded) | ✅ | ✅ `/watercooler admin summary` |
| Round history | ✅ Full dashboard | 🟡 Last 5 rounds via Slack command |
| Participation rate tracking | ✅ Dashboard + email | ❌ Not built |
| Meeting confirmation ("did they actually meet?") | ✅ | ❌ Not built |
| CSV export of match data | ✅ | ❌ Not built — data is in SQLite, exportable manually |
| Email reports | ✅ | ❌ Not built |
| Web dashboard | ✅ donut.ai | ❌ Not built |
| Sentiment / engagement trend analytics | ✅ Beta | ❌ Not built |

---

## Cost & Ownership

| Factor | Donut | Watercooler |
|---|---|---|
| Monthly cost | $0–$119+/month per workspace | Free — self-hosted |
| Data ownership | Donut's servers | Our own database |
| Customisable message content | Limited | ✅ Fully customisable |
| Source code access | ❌ Closed SaaS | ✅ We own it |
| Requires IT / SaaS procurement | Yes | No |

---

## Summary of Upcoming Efforts

Our custom Watercooler covers the full core matching loop that Donut is best known for: people opt in, get randomly matched on a schedule, receive a DM intro, and admins have commands to tune and monitor everything. For a small internal team this is the right starting point.

The gaps vs. Donut fall into three tiers of priority:

### 🔴 High Value, Low Effort

| Gap | Notes |
|---|---|
| Pause for N rounds (not indefinite) | Small DB change — add a `paused_until_round` field |
| Outlook / calendar link in the intro DM | One-line change to the message template |
| Conversation starter in the DM | Add a static prompt or small rotating list to the intro message |
| Skip next round (admin command) | Small — one new admin subcommand |

### 🟡 Medium Value, Medium Effort

| Gap | Notes |
|---|---|
| **Auto-enroll new hires (opt-out by default)** | **Decided: build next.** Listen for Slack's `team_join` event, auto-create the user as active, send a welcome DM explaining the program and how to leave. Matches how Donut works — higher participation without requiring action from new employees. |
| **Outlook calendar integration + Teams auto-booking** | **Decided: build after auto-enroll.** See `docs/OUTLOOK_INTEGRATION.md` for the full plan. After matching, app reads both calendars, suggests 3+ free 15-min slots in the DM as clickable buttons, creates a Teams invite when one person confirms. Auto-books after 2.5 days (configurable, supports decimals) if nobody responds. Disabled by default behind `CALENDAR_ENABLED` flag — requires one-time Azure AD setup with IT. |
| Participation rate tracking | Track whether matched users confirm they met |
| CSV export of match history | Query the SQLite DB and format as CSV |
| Smart matching (avoid pairing people already in the same channels) | Requires reading Slack channel membership at match time |
| Cross-team / within-team matching rules | Tag users with a team attribute, filter in the matching engine |

### 🟢 Nice to Have

| Gap | Notes |
|---|---|
| Web admin dashboard | Significant effort — full frontend needed |
| Multi-program support (multiple Donut channels) | Medium — currently one config per workspace |
| Birthday / work anniversary celebrations | New feature category, separate from matching |

### ⚪ Likely Out of Scope

| Gap | Notes |
|---|---|
| HRIS sync | Very large — external API integrations, auth flows |
| Peer recognition + rewards store | Separate product category, not matching-related |
| Sentiment analytics / Team Pulse | Requires longitudinal data collection and a dashboard |

---

*Sources: [Donut Help Center](https://help.donut.ai), [Donut Slack Marketplace](https://slack.com/apps/A11MJ51SR-donut), [Donut Pricing](https://help.donut.ai/en/articles/3423191-donut-pricing-free-standard-premium), [Donut Intro Types](https://help.donut.ai/en/articles/3024637-intro-types), [Donut Integrations](https://www.donut.com/platform/integrations/)*
