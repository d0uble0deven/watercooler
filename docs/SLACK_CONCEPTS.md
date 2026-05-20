# Slack Concepts Reference

Plain-English explanations of every Slack-specific concept used in this project.
Written for someone who has never built a Slack app before.

---

## The big picture

```
   ┌───────────────┐  user types /watercooler status
   │  Slack client │ ─────────────────────────────────┐
   └───────────────┘                                  │
           ▲                                          ▼
           │                                ┌─────────────────┐
           │   Slack posts a webhook to a   │  Slack servers  │
           │   public URL you registered.   └─────────────────┘
           │                                          │
           │   "POST /slack/events"                   │
           │   payload: who, what,                    │
           │   workspace, signed signature.           │
           │                                          ▼
   ┌──────────────────────────────────────────────────────┐
   │  Your Node + Express + Slack Bolt app (port 3000)    │
   │   - verifies signature                               │
   │   - routes the command                               │
   │   - reads/writes SQLite                              │
   │   - replies via Slack Web API                        │
   └──────────────────────────────────────────────────────┘
```

The single most important thing to understand:
**Slack is just an HTTP client that POSTs JSON to you when something happens,
and you POST JSON back to Slack when you want to do something.**
Everything else is bookkeeping.

---

## Slack app

A registered entity in Slack's admin panel. It has:
- a name, icon, description
- a set of **scopes** (permissions)
- one or more **tokens** (credentials for calling Slack)
- a list of **request URLs** (where Slack sends events / commands)
- one or more **slash commands** (e.g. `/watercooler`)
- one or more **event subscriptions** (optional — e.g. "tell me when someone joins")

You create one at https://api.slack.com/apps.
Once installed into a workspace, it gets a bot user and tokens you can use.

---

## Slack Bolt for JavaScript

A library by Slack that handles the annoying parts:
- verifying request signatures (so you know the request really came from Slack)
- parsing payloads (so you get structured objects, not raw JSON)
- routing slash commands / events / actions to your handlers
- providing an SDK (`app.client.chat.postMessage(...)`) for talking back

Without Bolt you'd be writing all of that yourself.
Bolt is deliberately thin — it doesn't hide much, which makes it easy to debug.

---

## Bot token (`xoxb-...`)

The credential your code uses when calling Slack.
It identifies your bot user and grants it whatever scopes you requested.
**Treat it like a password.** Lives in `.env`. Never in git.

---

## Signing secret

A separate secret Slack uses to sign every request it sends you.
Your app uses it to verify "yes, this really came from Slack, not a random attacker."
Bolt handles this verification automatically — you just provide the secret.
Also lives in `.env`. Never in git.

---

## Slash command

A user typing `/watercooler join` in any Slack channel or DM.
Slack catches it and POSTs a payload to your request URL:
```json
{
  "command": "/watercooler",
  "text": "join",
  "user_id": "U01ABC123",
  "channel_id": "C01DEF456",
  "team_id": "T01GHI789",
  "response_url": "https://hooks.slack.com/commands/..."
}
```
**You have 3 seconds to respond** with an HTTP 200 (or a "thinking..." message)
before Slack shows a timeout error to the user.
That's why the first thing every Bolt command handler does is `await ack()`.

---

## Scopes

Granular permissions your app requests at registration time.
The workspace admin approves them when installing the app.

Scopes this project uses:

| Scope | Why |
|---|---|
| `commands` | Register `/watercooler` |
| `chat:write` | Post messages |
| `chat:write.public` | Post in channels the bot isn't a member of |
| `users:read` | Look up display names |
| `im:write` | Open 1:1 DMs |
| `mpim:write` | Open group DMs (for match intros) |

---

## Event subscriptions

Slack can POST to you when things happen (a message is posted, a user joins, etc.).
This project doesn't use them in the early phases — slash commands are enough.
They become relevant if you want to react to someone mentioning the bot, etc.

---

## Socket Mode vs. HTTP Mode

Two ways Slack can deliver events to you:

| Mode | How | Needs public URL? |
|---|---|---|
| **Socket Mode** | Your app opens a WebSocket *to* Slack. | ❌ No |
| **HTTP Mode** | Slack POSTs to a URL you expose. | ✅ Yes |

**This project uses Socket Mode.**
No public URL = no ngrok = one less moving part in local dev.
You'll need to switch to HTTP Mode if you ever host this on a server with a public URL.

### What is ngrok? (for reference, if you ever switch to HTTP Mode)
ngrok is a tool that creates a temporary public HTTPS URL
(like `https://abc123.ngrok.io`) that tunnels traffic to your `localhost:3000`.
You'd paste that URL into Slack's settings so Slack knows where to POST events.
Not needed for Socket Mode.

---

## App-Level Token (`xapp-...`)

A special token required only for Socket Mode.
Different from the Bot Token — it's used to authenticate the WebSocket connection itself.
You generate it separately in your app's settings under "Socket Mode."
Give it the `connections:write` scope.

---

## Slack Web API

The HTTP API you call to *do* things in Slack:
- `conversations.open` — create a group DM (used for match introductions)
- `chat.postMessage` — post a message into a channel or DM
- `users.info` — look up a user's display name

Bolt gives you a wrapped client: `app.client.conversations.open({ users: [id1, id2] })`.

---

## Group DMs (mpim)

How Watercooler delivers match introductions.
Calling `conversations.open` with multiple user IDs creates a multi-person DM.
Slack returns a channel ID for it.
You then call `chat.postMessage` with that channel ID to post the intro.
This is exactly how Donut works.

---

## How Slack connects to this app (Socket Mode flow)

1. App starts → Bolt opens a WebSocket connection to `wss://wss-primary.slack.com`
2. Slack authenticates the connection using your `SLACK_APP_TOKEN`
3. User types `/watercooler status` in Slack
4. Slack sends the payload over the WebSocket (not HTTP)
5. Bolt receives it, routes it to your `app.command('/watercooler', ...)` handler
6. Your handler calls `await ack()` to acknowledge receipt
7. Your handler calls `await respond(...)` to reply to the user
8. Bolt sends the response back over the same WebSocket

---

## Checklist: creating a Slack app (when you're ready)

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**
2. Name: "Watercooler" — pick your workspace
3. **Socket Mode** tab → Enable → Generate App-Level Token → scope: `connections:write` → copy as `SLACK_APP_TOKEN`
4. **OAuth & Permissions** → add bot scopes from the Scopes table above
5. **Slash Commands** → create `/watercooler` → description: "Manage Watercooler matching" → usage hint: `[join|pause|resume|leave|status]`
6. **Install to Workspace** → copy Bot User OAuth Token as `SLACK_BOT_TOKEN`
7. **Basic Information** → copy Signing Secret as `SLACK_SIGNING_SECRET`
8. In Slack: open your profile → ⋮ → **Copy member ID** → paste into `ADMIN_USER_IDS`
