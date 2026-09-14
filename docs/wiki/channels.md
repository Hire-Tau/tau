# Channel Integration

## Settings location

Discord, Slack, and Telegram are separate cards in **Settings → Integrations**. Enable a card, save its bot credentials, then configure its channel routing and squad overrides there. Credentials are no longer edited through Secrets & Keys. Secret fields show whether a value is configured without revealing it. Existing configured bots remain enabled on upgrade; new integrations start disabled.

Under the provider's **Channel routing**, choose **+ Add New**, enter a name and
the provider identifier, select **Default Squad**, optionally add channel/chat
overrides, and choose **Create**. The identifier is the Discord server ID, Slack
workspace ID, or numeric Telegram bot ID (the bot token's prefix before the
colon). The default squad is required, even when overrides are configured.
Create and Save show an error at the field if it is empty. Existing connections
with no default show **Needs configuration**, including when collapsed. Expand
the connection, select a default, and save (or ask an administrator). This does
not silently replace a deleted squad or move an existing conversation.
UI-created routing is saved directly;
it does not require a YAML file or a configuration-sync restart. You need
`channels:create` to add routing and `channels:update` to change it.

The channel adapters, thread handling, and routing system described below remain in place. The integration switch gates their credentials; disabling Discord also stops its gateway, and changing its token reconnects it. Slack clients pick up token changes on their next request. Configuration edits still use channel permissions; credential edits require the provider’s integration permission.

Channels connect external platforms (Discord, Slack, Telegram) to Tau squads via
a **concierge agent**. The current bundled concierge is a member of its routed
squad: it answers questions and creates work streams directly, with its configured
permissions and tools. It forwards squad-specific operational decisions when
appropriate rather than forwarding every action request to a manager.

## Overview

```
Discord/Slack User
       ↓
  Webhook Endpoint
       ↓
  Concierge Agent (per conversation, in the routed squad)
       ↓
  ┌─────────────────────────────────────┐
  │ Can handle directly:                │
  │ - Status checks (/tau status)       │
  │ - Questions (/tau ask)              │
  │ - Create and follow work streams   │
  └─────────────────────────────────────┘
       ↓ (when an operational decision needs the manager)
  Squad Manager
       ↓
  ┌─────────────────────────────────────┐
  │ Requires manager:                   │
  │ - Squad-specific operations        │
  └─────────────────────────────────────┘
```

## Commands

| Command          | Description                    | Handler   |
| ---------------- | ------------------------------ | --------- |
| `/tau status`    | Show active work streams       | Immediate |
| `/tau <message>` | Ask questions or make requests | Concierge |

The concierge handles all freeform messages intelligently:

- **Questions** — Answered directly by searching memory, checking status, etc.
- **Action requests** — The concierge can create and own work in its routed
  squad. Operational decisions may be forwarded to the squad manager.

## Thread Replies

For threaded providers, users can continue conversations with the concierge by replying to bot messages:

- **Each slash command creates a new thread** — When you run `/tau ask` or any other command, the bot's response starts a conversation thread.
- **Replies are routed to the same concierge** — Simply reply to the bot's message in the thread to continue the conversation. The concierge maintains context within the thread.
- **Thread isolation** — Each thread is an independent conversation. Starting a new slash command creates a new thread.

Discord and Slack use native threads. Telegram instead reuses a concierge per chat:

| Platform | Threading Behavior                                                  |
| -------- | ------------------------------------------------------------------- |
| Discord  | Uses Discord threads; slash commands in threads route to same agent |
| Slack    | Uses Slack's native thread replies                                  |
| Telegram | Reuses one addressable concierge per chat; replies use message IDs  |

> **Slack note:** Start custom slash commands in the channel composer. To continue a conversation in Slack, **reply to the bot's message** instead of starting another `/tau` command.

## Discord Setup

### 1. Create Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** and give it a name (e.g., "Tau")
3. Go to **General Information** and copy:
   - **Application ID** → `DISCORD_APPLICATION_ID`
   - **Public Key** → `DISCORD_PUBLIC_KEY`

### 2. Create Bot

1. Go to **Bot** section
2. Click **Reset Token** and copy → `DISCORD_BOT_TOKEN`
3. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** — Required for reading thread replies

### 3. Set Secrets

Add via the matching Settings → Integrations card (or `.env` for initial setup):

```
DISCORD_APPLICATION_ID=your_app_id
DISCORD_PUBLIC_KEY=your_public_key
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_GUILD_ID=your_guild_id   # optional: faster command updates in one guild
```

### 4. Configure Interactions

1. Go to **General Information**
2. Set **Interactions Endpoint URL** to:
   ```
   https://your-domain.com/api/webhooks/channels/discord
   ```
3. Discord will verify the endpoint using your public key

### 5. Register Commands

Register slash commands using the CLI (from a checkout, build it first with
`bun run build:cli`). Set `DISCORD_BOT_TOKEN` and `DISCORD_APPLICATION_ID` in
the command's shell environment. These commands call Discord directly and do
not read credentials saved in Tau's integration card:

```bash
tau discord register
```

For faster development, set `DISCORD_GUILD_ID` for guild-specific commands (instant updates vs. up to 1 hour for global).

To check status or fix duplicate commands:

```bash
tau discord status                # Show registered commands
tau discord clear --scope global  # Clear global commands (fix duplicates)
tau discord clear --scope all     # Clear both global and guild commands
```

### 6. Invite Bot

1. Go to **OAuth2 → URL Generator**
2. Select scopes: `bot`, `applications.commands`
3. Select permissions: `Send Messages`, `Use Slash Commands`, `Send Messages in Threads`, `Create Public Threads`
4. Copy the generated URL and open it to invite the bot

### 7. Configure Channel Instance (Discord)

In **Settings → Integrations → Discord → Channel routing**, choose **+ Add New**.
Enter the name and **Discord server ID**, choose **Default Squad**, add any
channel overrides, and choose **Create**.

For template-managed configuration, the equivalent YAML in `config/channels/` is:

```yaml
# config/channels/my-discord.yaml
id: my-discord-server
name: My Discord Server
provider: discord
providerConfig:
  guildId: 'YOUR_GUILD_ID'

# Optional: map specific channels to squads
channelSquadMap:
  'frontend-channel-id': 'frontend-squad-uuid'
  'backend-channel-id': 'backend-squad-uuid'

defaultSquadId: 'squad-uuid-1'
```

Restart Tau to sync a newly added YAML template
(`tau server restart`, or `bun run pm2:restart` in a checkout).

### 8. Verify Discord Integration

```bash
# webhooks:read required — the bootstrap TAU_PASSWORD works until the first admin passkey exists
curl -H "Authorization: Bearer $TAU_PASSWORD" https://your-domain.com/api/webhooks/channels/discord/status
# {"provider":"discord","registered":true,"secretConfigured":true}
```

Try `/tau help` in your Discord server to verify commands work.

## Slack Setup

Slack integration supports slash commands, thread replies, reactions, and rich messaging — similar to Discord.

### Option A: Use App Manifest (Recommended)

The easiest way to set up the Slack app is using the pre-configured manifest:

1. Go to [Slack API](https://api.slack.com/apps)
2. Click **Create New App** → **From an app manifest**
3. Select your workspace
4. Copy the contents of `config/channels/slack-app-manifest.example.yaml`
5. Replace `YOUR_DOMAIN` with your actual domain (e.g., `tau.example.com`)
6. Paste the YAML and click **Next**
7. Review the configuration and click **Create**
8. Go to **Install App** and click **Install to Workspace**
9. Add credentials via the matching Settings → Integrations card (or `.env` for initial setup):
   - **Basic Information → App Credentials → Signing Secret** → `SLACK_SIGNING_SECRET`
   - **OAuth & Permissions → Bot User OAuth Token** → `SLACK_BOT_TOKEN`

Skip to [Configure Channel Instance](#7-configure-channel-instance) after using the manifest.

### Option B: Manual Setup

If you prefer to configure the app manually or need to customize settings:

#### 1. Create App

1. Go to [Slack API](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Name it (e.g., "Tau") and select your workspace

#### 2. Configure Slash Command

1. Go to **Slash Commands**
2. Click **Create New Command**:
   - **Command:** `/tau`
   - **Request URL:** `https://your-domain.com/api/webhooks/channels/slack`
   - **Description:** "Interact with Tau AI assistant"
   - **Usage Hint:** `[status|ask|help] [message]`

#### 3. Get Signing Secret

1. Go to **Basic Information**
2. Under **App Credentials**, copy **Signing Secret** → `SLACK_SIGNING_SECRET`

#### 4. Configure OAuth & Permissions

1. Go to **OAuth & Permissions**
2. Under **Scopes → Bot Token Scopes**, add all required scopes:

**Slash Commands:**

| Scope      | Description                             |
| ---------- | --------------------------------------- |
| `commands` | Required for slash command registration |

**Core Messaging:**

| Scope               | Description                                         |
| ------------------- | --------------------------------------------------- |
| `chat:write`        | Send messages as the bot                            |
| `chat:write.public` | Send messages to channels the bot isn't a member of |

**Thread & Message History (for context and replies):**

| Scope              | Description                       |
| ------------------ | --------------------------------- |
| `channels:history` | Read messages in public channels  |
| `groups:history`   | Read messages in private channels |
| `im:history`       | Read direct message history       |
| `mpim:history`     | Read group DM history             |

**Channel Information:**

| Scope           | Description                              |
| --------------- | ---------------------------------------- |
| `channels:read` | List and get info about public channels  |
| `channels:join` | Join public channels (for thread events) |
| `groups:read`   | List and get info about private channels |
| `im:read`       | List and get info about DMs              |
| `mpim:read`     | List and get info about group DMs        |

**User Information:**

| Scope        | Description                               |
| ------------ | ----------------------------------------- |
| `users:read` | Get user display names, avatars, profiles |

**Reactions:**

| Scope             | Description                      |
| ----------------- | -------------------------------- |
| `reactions:write` | Add emoji reactions to messages  |
| `reactions:read`  | Read emoji reactions on messages |

**Files (optional, for attachments):**

| Scope         | Description             |
| ------------- | ----------------------- |
| `files:write` | Upload files and images |
| `files:read`  | Read file information   |

**DM Support:**

| Scope      | Description                   |
| ---------- | ----------------------------- |
| `im:write` | Open and send direct messages |

**@Mention Events:**

| Scope               | Description                                   |
| ------------------- | --------------------------------------------- |
| `app_mentions:read` | Required for `app_mention` event subscription |

3. Click **Install to Workspace** (or reinstall if already installed)
4. Copy **Bot User OAuth Token** → `SLACK_BOT_TOKEN`

#### 5. Enable Events API (for thread replies)

1. Go to **Event Subscriptions**
2. Toggle **Enable Events** to On
3. Set **Request URL** to: `https://your-domain.com/api/webhooks/channels/slack`
4. Wait for Slack to verify the URL
5. Under **Subscribe to bot events**, add:
   - `message.channels` — Messages in public channels
   - `message.groups` — Messages in private channels
   - `message.im` — Direct messages to the bot
   - `message.mpim` — Messages in group DMs
   - `app_mention` — When someone @mentions the bot
6. Click **Save Changes**

#### 6. Install App

1. Go to **Install App**
2. Click **Install to Workspace** (or reinstall if you added new scopes)
3. Authorize the app

### 7. Configure Channel Instance

In **Settings → Integrations → Slack → Channel routing**, choose **+ Add New**.
Enter a name and **Slack workspace ID**, select **Default Squad**, optionally
add channel overrides, and choose **Create**. To find the Slack team ID, open the
workspace in a browser and look at the URL — it looks like
`https://app.slack.com/client/T0123ABCD/C01234567`, and the team ID is the part
starting with `T` (`T0123ABCD`).

For template-managed configuration, use:

```yaml
# config/channels/my-slack.yaml
id: my-slack-workspace
name: My Slack Workspace
provider: slack
providerConfig:
  teamId: 'T0123ABCD' # Your workspace ID

defaultSquadId: 'squad-uuid-1'
```

Restart Tau to sync a newly added YAML template. UI-created routing does not
need this restart.

### 8. Verify Slack Integration

Try `/tau help` in your Slack workspace to verify commands work.

## Telegram Setup

### 1. Create Bot

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the **bot token** → `TELEGRAM_BOT_TOKEN`
4. Note the numeric bot ID: the portion of its token before the colon.

### 2. Generate Webhook Secret

Generate a secret token (1-256 characters, A-Za-z0-9\_- only):

```bash
openssl rand -hex 32
```

This becomes `TELEGRAM_WEBHOOK_SECRET`.

### 3. Set Secrets

Add via the matching Settings → Integrations card (or `.env` for initial setup):

```
TELEGRAM_BOT_TOKEN=123456789:ABCdef...
TELEGRAM_WEBHOOK_SECRET=your_generated_secret
TELEGRAM_BOT_ID=123456789  # Numeric prefix of the bot token, before the colon
```

### 4. Register Webhook

Register your webhook URL with Telegram's API:

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://your-domain.com/api/webhooks/channels/telegram&secret_token=<YOUR_SECRET>"
```

Expected response: `{"ok":true,"result":true,"description":"Webhook was set"}`

### 5. Configure Channel Instance

In **Settings → Integrations → Telegram → Channel routing**, choose **+ Add New**.
Enter a name, the numeric **Telegram bot ID**, and **Default Squad**. Add any chat
overrides and choose **Create**. The bot ID must match the **Bot ID** saved in the
Telegram credential settings; a chat override uses the destination chat ID.

For template-managed configuration, use:

```yaml
# config/channels/my-telegram.yaml
id: my-telegram-bot
name: My Telegram Bot
provider: telegram
providerConfig:
  botId: '123456789' # Must match TELEGRAM_BOT_ID

defaultSquadId: 'squad-uuid-1'
```

Restart Tau to sync a newly added YAML template. UI-created routing does not
need this restart.

### 6. Test the Bot

Start a chat with your bot on Telegram and try these commands:

- `/tau help` or `/help` — Show available commands
- `/tau status` or `/status` — Show active work streams
- `/tau ask how does auth work?` — Ask a question
- Just type a question directly — Treated as `/tau ask`

If nothing comes back, check what Telegram thinks the webhook is:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

## Channel Instance Configuration

Channel instances link external platforms to squads. See
`config/channels/example-discord.yaml`, `config/channels/example-slack.yaml`,
and `config/channels/example-telegram.yaml` for full examples.

| Field                    | Description                                      |
| ------------------------ | ------------------------------------------------ |
| `id`                     | Unique identifier for the channel instance       |
| `name`                   | Human-readable name                              |
| `provider`               | `discord`, `slack`, or `telegram`                |
| `providerConfig.guildId` | Discord guild/server ID                          |
| `providerConfig.teamId`  | Slack workspace ID                               |
| `providerConfig.botId`   | Telegram numeric bot ID; match `TELEGRAM_BOT_ID` |
| `channelSquadMap`        | Map specific platform channels to squads         |
| `defaultSquadId`         | Default squad for unrouted requests              |

## Multi-Squad Support

A channel instance can route to multiple squads. Inbound routing is deterministic:

1. **Channel mapping** — If the provider channel/chat ID is mapped to a specific squad in `channelSquadMap`, use that squad
2. **Default squad** — Use `defaultSquadId` if set

If neither resolves a squad, no new concierge can be created. Telegram sends an
in-chat configuration error before posting Thinking, provided its Bot API
transport can send. The same applies to `/tau status`, which needs a target
squad; `/tau help` remains available without one.

Create and update operations require a default squad even with overrides. Legacy
null defaults can remain, for example after the referenced squad is deleted.
Matching overrides still route new chats, and an existing addressable Telegram
chat concierge is intentionally reused without resolving a new default. The
warning therefore does not mean every existing conversation has stopped.
The concierge's later decision to consult another squad is separate from this
initial routing.

## Concierge Agent

The current concierge is **squad-scoped**:

- `agentTypeId: concierge`
- `squadId` is the resolved target squad
- New conversational commands create their own concierge for thread isolation;
  replies continue the associated conversation
- The bundled prompt permits work-stream creation and ownership and delegates
  implementation to work streams rather than writing code itself

The reusable warm-concierge path is also scoped to the resolved/default squad.
See [ChannelInstance](../../apps/core/src/entities/ChannelInstance.ts) and the
[bundled concierge type](../../config/agent-types/concierge.yaml) for the current
routing and agent contract.

## Environment Variables

| Variable                  | Required     | Description                                     |
| ------------------------- | ------------ | ----------------------------------------------- |
| `DISCORD_APPLICATION_ID`  | For Discord  | Discord application ID                          |
| `DISCORD_PUBLIC_KEY`      | For Discord  | For webhook signature verification              |
| `DISCORD_BOT_TOKEN`       | For Discord  | For registering slash commands                  |
| `DISCORD_GUILD_ID`        | No           | Guild ID for dev (faster command updates)       |
| `SLACK_SIGNING_SECRET`    | For Slack    | For webhook signature verification              |
| `SLACK_BOT_TOKEN`         | For Slack    | For sending messages and reading thread replies |
| `TELEGRAM_BOT_TOKEN`      | For Telegram | Bot token from @BotFather                       |
| `TELEGRAM_WEBHOOK_SECRET` | For Telegram | Secret token for webhook verification           |
| `TELEGRAM_BOT_ID`         | For Telegram | Numeric bot ID (must match channel config)      |

## Troubleshooting

### Discord: "Invalid signature"

- Verify `DISCORD_PUBLIC_KEY` matches your app's public key
- Ensure the interactions URL uses HTTPS
- Check that the endpoint returns a PONG for Discord's verification ping

### Slack: "Invalid signature"

- Verify `SLACK_SIGNING_SECRET` matches your app's signing secret
- Check that your server's clock is synchronized (signatures have a 5-minute window)

### Telegram: Bot not responding

An HTTP 200 webhook acknowledgement is **not** proof of a visible bot reply.
Telegram replies are separate `sendMessage` API requests. Complete silence,
including no Thinking indicator, can happen at several distinct stages:

1. **No delivery:** the webhook URL, TLS, ingress, or Telegram delivery may fail
   before Tau receives anything. With authorized access, inspect Telegram's
   `getWebhookInfo` and correlate receipt in Core logs. Do not change webhook
   registration just to diagnose a missing reply.
2. **Rejected delivery:** a disabled integration hides its credentials; a missing
   or mismatched `TELEGRAM_WEBHOOK_SECRET` rejects the webhook with 401. Verify
   the integration is enabled and the secret matches the registered webhook.
3. **Ignored update:** only text messages are processed. Private plain text is
   actionable without `/tau` or a reply. Group text requires `/tau` or a
   reply-to-bot; photos without text and other non-message updates are ignored.
4. **Missing bot/connection routing:** the credential settings' numeric
   `TELEGRAM_BOT_ID` must match `providerConfig.botId` on the connection. Missing
   IDs or connections now produce an in-chat configuration error when sending
   is possible; older versions only returned an HTTP acknowledgement here.
5. **Send failure:** a missing/invalid bot token, blocked bot, unavailable chat,
   invalid reply target, or HTTP/network/API error can prevent either Thinking
   or the configuration reply. Check the outgoing API result, not just the
   incoming webhook status. Chat IDs identify reused concierges, while Telegram
   `reply_to_message_id` must be the incoming **message** ID. Older versions used
   the chat ID for Thinking in an existing chat, which could be rejected.

A missing default alone does not establish the cause of a reported silent
message. Before diagnosing an incident, collect the bot identity, deployment,
private/group context, message time and timezone, and authorized receipt/send
logs. Keep bot tokens, webhook secrets, credential-bearing URLs, and private
message contents out of shared diagnostics.

### Commands not appearing

- For Discord: Wait up to 1 hour for global commands, or use `DISCORD_GUILD_ID` for instant guild updates
- For Slack: Reinstall the app to your workspace
- For Telegram: Commands work immediately after webhook is set

### "This server/workspace is not configured"

- Create the routing entry under **Settings → Integrations → provider → Channel routing**
- For YAML-managed entries only, restart Tau to sync the configuration
- Verify the `guildId`/`teamId`/`botId` matches the platform

## Architecture

See `/memory/decisions/discord-slack-concierge.md` for the full design document.

## Notifications

Send high-signal squad notifications to Discord, Slack, or Telegram channels
when work streams complete or need review. Notifications reuse the same bot
configured for slash commands — no separate webhooks needed. Blocked events
require an explicit custom rule.

**Prerequisites:** the channel bot must already be set up ([Discord](#discord-setup),
[Slack](#slack-setup), [Telegram](#telegram-setup)).

### Option 1: Use slash commands (easiest)

From any channel where your bot is present:

```
/tau notify <squad-name>
```

This configures the current channel to receive notifications for that squad. To
unsubscribe:

```
/tau unnotify <squad-name>
```

### Option 2: Configure via web UI

1. Go to the squad's **Settings** tab
2. Select the **Notifications** section
3. For each platform (Discord/Slack/Telegram):
   - Select the channel instance (bot)
   - Enter the channel/chat ID where notifications should be sent
4. Click **Save Changes**

### Option 3: Configure via CLI

Set the notification config in squad metadata:

```bash
# Discord - use channel instance ID and Discord channel ID
tau squad set-meta <squad-id> notifications.discord.instanceId "<instance-id>"
tau squad set-meta <squad-id> notifications.discord.channelId "<discord-channel-id>"

# Slack - use channel instance ID and Slack channel ID
tau squad set-meta <squad-id> notifications.slack.instanceId "<instance-id>"
tau squad set-meta <squad-id> notifications.slack.channelId "<slack-channel-id>"

# Telegram - use channel instance ID and Telegram chat ID
tau squad set-meta <squad-id> notifications.telegram.instanceId "<instance-id>"
tau squad set-meta <squad-id> notifications.telegram.channelId "<telegram-chat-id>"
```

To find IDs:

- **Instance ID**: check `config/channels/*.yaml` or the web UI channel instances list
- **Discord channel ID**: right-click the channel → Copy Channel ID (enable Developer Mode in Discord settings)
- **Slack channel ID**: click the channel name → About → scroll to the bottom
- **Telegram chat ID**: use the `/tau notify` command, or read it from the bot API

### Events that trigger notifications

Configured in `config/notifications/rules.yaml`:

| Event                 | Description                        | Default Channels                        |
| --------------------- | ---------------------------------- | --------------------------------------- |
| `workStream.blocked`  | Agent blocked and needs help       | none (explicit custom rule only)        |
| `workStream.review`   | Work stream ready for human review | push, discord, slack, telegram          |
| `workStream.done`     | Work stream completed              | discord, slack, telegram                |
| `execution.completed` | Agent execution finished           | console                                 |
| `execution.failed`    | Agent execution failed             | push, console, discord, slack, telegram |

### Notification URLs

Set `APP_URL` in `.env` to include clickable links in notifications:

```bash
APP_URL=https://your-domain.com
```

If not set, notifications are sent without URLs.

### Disable notifications

Remove the notification config:

```bash
# Remove Discord notifications for a squad
tau squad set-meta <squad-id> notifications.discord null

# Or remove all notifications
tau squad set-meta <squad-id> notifications null
```
