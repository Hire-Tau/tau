# Channel Integration

## Settings location

Discord, Slack, and Telegram are separate cards in **Settings → Integrations**.
Each card holds one **connection** for the provider: paste the bot token (and
the Slack signing secret), and Tau validates it, records the bot's identity, and
does the provider-side registration itself. Secret fields show whether a value
is configured without revealing it, and credentials are not edited through
Secrets & Keys. Existing configured bots remain enabled on upgrade; new
integrations start disabled.

Pick a **Default squad** on the card and messages arriving through that bot
route there. **Channel routing** on the card holds per-channel overrides. The
default squad is required. UI-created routing is saved directly; it does not
require a YAML file or a configuration-sync restart. You need `channels:create`
to add routing and `channels:update` to change it; credential edits require the
provider's integration permission (`integrations:<provider>:write`).

The integration switch gates the transport; disabling Discord also stops its
gateway, and saving a new token reconnects it. Slack clients pick up token
changes on their next request.

Channels connect external platforms (Discord, Slack, Telegram) to Tau squads via
a **consultant agent**. The consultant is a member of its routed
squad: it answers questions and creates work streams directly, with its configured
permissions and tools. It forwards squad-specific operational decisions when
appropriate rather than forwarding every action request to a manager.

## Overview

```
Discord/Slack User
       ↓
  Webhook Endpoint
       ↓
  Consultant Agent (per conversation, in the routed squad)
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

| Command          | Description                    | Handler    |
| ---------------- | ------------------------------ | ---------- |
| `/tau status`    | Show active work streams       | Immediate  |
| `/tau <message>` | Ask questions or make requests | Consultant |

The consultant handles all freeform messages intelligently:

- **Questions** — Answered directly by searching memory, checking status, etc.
- **Action requests** — The consultant can create and own work in its routed
  squad. Operational decisions may be forwarded to the squad manager.

## Sender authorization and conversation reuse

Ingress verifies the provider signature (or Discord gateway session) before using
its sender ID. `channel-access.ts` checks either an exact trusted channel ID or a
confirmed external identity linked to an enabled Tau user with current `chat:send`
permission for the routed squad. Permission lookup bypasses the RBAC cache so
revocation applies to the next message. Help and account linking do not start an
agent and are available before this check. Notification commands can change only
the squad routed to that channel.

`/api/channel-links` is a personal authenticated-user API. A user starts a random,
short-lived challenge in Tau, submits it through authenticated provider ingress,
and confirms the displayed sender in Tau. Only hashes are stored. Confirmation
and uniqueness checks happen in a transaction. Links bind the instance and its
provider identity, not display names; reusing a routing record for another Slack
workspace invalidates old proofs and access. Unlink and disabled users fail closed.

Trusted channels explicitly bypass user linking. Anyone who can message there can
direct squad agents, including asking the manager to act. This is not a restricted
query interface. Replies remain in the originating channel; the sender chooses
the audience. Thread history excludes unlinked/unpermitted senders outside trusted
channels. Discord routing and trust use a verified parent channel for threads.

Slack and Discord continue a conversation on an explicit bot mention in a thread;
unmentioned replies are ignored. Discord also accepts slash commands in a thread.
Telegram reuses one conversation per chat and responds to private messages, group
`/tau` commands, and replies to bot messages. Lookups are scoped to provider,
instance, channel, thread, and the currently routed squad. A changed squad override
does not resume an agent in the old squad.

Telegram's persistent conversation ID is its chat ID. It must never be passed as
`reply_to_message_id`: `postMessage.replyToMessageId` carries an optional incoming
message ID separately. Follow-up acknowledgements reply to that message; later
updates may post without a reply target.

## Connecting a provider

Each provider is one **connection** on the instance, saved from its card in
**Settings → Integrations**. Paste the secret the provider gives you; Tau
validates it against the provider, records who the bot is (bot id, workspace,
application), and does the provider-side setup that used to be manual. Pick a
**Default squad** on the same card and the routing entry is created for you;
**Channel routing and access** below it is only for per-channel overrides.

Connections are ordinary integration connections: they appear in
`GET /api/integrations/connections?provider=<provider>`, are re-validated by the
revalidation worker, and are audited. The provider switch (**Enable** on the
card, `PUT /api/integrations/providers/<provider>/enabled`) stops the transport
without discarding the credential.

### Telegram

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the
   bot token.
2. Paste it into the Telegram card and save. Tau calls `getMe` to validate,
   records the bot id and username, generates a webhook secret, and registers
   the webhook (`https://<instance>/api/webhooks/channels/telegram`) with
   Telegram. Switching the provider off removes the webhook.
3. Choose a **Default squad** on the card. Optional: add chat overrides under
   Channel routing.

### Slack

1. On the Slack card, **Download the Slack app manifest** — it already carries
   this instance's URL for the `/tau` command and Events API.
2. At [api.slack.com/apps](https://api.slack.com/apps) choose **Create New App
   → From an app manifest**, paste it, create, then **Install to Workspace**.
3. Paste the app's **Bot User OAuth Token** and **Signing Secret** into the card
   and save. Tau calls `auth.test`, records the workspace and bot user id.
4. Choose a **Default squad**. Invite the bot to the channels it should answer in.

Reinstall the Slack app after changing scopes. The manifest's scope list is the
bot's contract; the copy in `config/channels/slack-app-manifest.example.yaml`
is the template the download is rendered from.

### Discord

1. In the [Developer Portal](https://discord.com/developers/applications)
   create an application, open **Bot**, **Reset Token**, and copy it. Under
   **Privileged Gateway Intents** enable **Message Content Intent** (thread
   replies).
2. Paste the token into the Discord card and save. Tau validates it, records
   the application id and public key from `/applications/@me`, registers the
   `/tau` slash commands, and (re)connects the gateway.
3. Copy the **Interactions Endpoint URL** shown on the card
   (`https://<instance>/api/webhooks/channels/discord`) into **General
   Information** in the portal; Discord verifies it with the public key Tau
   already has.
4. Invite the bot: **OAuth2 → URL Generator**, scopes `bot` and
   `applications.commands`, permissions Send Messages, Use Slash Commands, Send
   Messages in Threads, Create Public Threads.
5. Choose the **server** (shown once the bot is in one; picked automatically
   when it is in exactly one) and a **Default squad**. Commands register to that
   server for instant availability; without a chosen server they register
   globally and can take up to an hour to appear.

`tau discord status` and `tau discord clear` remain as diagnostics; they take
the bot token and application id as flags or environment variables because the
CLI has no access to the instance's connections. Registration itself no longer
needs the CLI.

### Verifying

```bash
# webhooks:read required — the bootstrap TAU_PASSWORD works until the first admin passkey exists
curl -H "Authorization: Bearer $TAU_PASSWORD" https://your-domain.com/api/webhooks/channels/<provider>/status
```

Then `/tau help` in the provider. The card's **Connection** section shows the
validation state and the identity the provider reported; a rejected credential
is kept and explained there rather than silently ignored.

## Channel routing

A routing entry (a _channel instance_) links one provider identity — Discord
server, Slack workspace, Telegram bot — to squads:

| Field                    | Description                                |
| ------------------------ | ------------------------------------------ |
| `id`                     | Unique identifier for the channel instance |
| `name`                   | Human-readable name                        |
| `provider`               | `discord`, `slack`, or `telegram`          |
| `providerConfig.guildId` | Discord guild/server ID                    |
| `providerConfig.teamId`  | Slack workspace ID                         |
| `providerConfig.botId`   | Telegram numeric bot ID                    |
| `channelSquadMap`        | Map specific platform channels to squads   |
| `defaultSquadId`         | Default squad for unrouted requests        |

Choosing a **Default squad** on the provider card creates or updates the entry
for the connection's own identity; **Channel routing and access** on the card edits it and
adds per-channel overrides. `config/channels/*.yaml` templates are still synced
for existing installs (`channelSquadMap` keyed by channel id, `defaultSquadId`),
but new installs do not need them.

## Multi-Squad Support

A channel instance can route to multiple squads. Inbound routing is deterministic:

1. **Channel mapping** — If the provider channel/chat ID is mapped to a specific squad in `channelSquadMap`, use that squad
2. **Default squad** — Use `defaultSquadId` if set

If neither resolves a squad, routing fails with a configuration error. New UI
and API entries require a default squad. The consultant's later decision to
consult another squad is separate from this initial routing.

## Channel consultants

New channel conversations use `agentTypeId: consultant`, scoped to the resolved
squad. The regular consultant runner adds `channel_respond`, `channel_send`, and
`channel_edit` when the agent has channel-instance context, and omits `ask_human`.
Its added instructions ask clarification questions and send updates in the channel.

Legacy concierge conversations are adopted as consultants on their next authorized
inbound message, preserving history. The old type remains for compatibility with
existing records; new channel agents do not use it. Config sync no longer creates
idle warm concierges. Agent allocation happens after sender authorization.

## Credentials and legacy environment variables

Credentials live in the provider's connection (`apps/core/src/services/integrations/channels/`):
the configuration holds the discovered identity, the encrypted credential holds
the secrets, and the transports read both through a per-process snapshot
(`getChannelIntegrationValue` is the compatibility boundary). Before connections,
the same material lived in these secret-store keys / environment variables; on
first boot after upgrading, a complete set is migrated into a connection, and the
keys keep serving as a fallback for one release:

| Variable                  | Now                                                  |
| ------------------------- | ---------------------------------------------------- |
| `DISCORD_BOT_TOKEN`       | Discord credential                                   |
| `DISCORD_APPLICATION_ID`  | Discovered from `/applications/@me`                  |
| `DISCORD_PUBLIC_KEY`      | Discovered from `/applications/@me`                  |
| `DISCORD_GUILD_ID`        | Chosen on the card (server for commands and routing) |
| `SLACK_BOT_TOKEN`         | Slack credential                                     |
| `SLACK_SIGNING_SECRET`    | Slack credential                                     |
| `TELEGRAM_BOT_TOKEN`      | Telegram credential                                  |
| `TELEGRAM_WEBHOOK_SECRET` | Generated by Tau when a token is saved               |
| `TELEGRAM_BOT_ID`         | Discovered from `getMe`                              |

Platform-managed keys (`TAU_MANAGED_SECRET_KEYS`) are not migrated or editable;
the transports keep reading them directly.

## Troubleshooting

### Discord: "Invalid signature"

- Verify `DISCORD_PUBLIC_KEY` matches your app's public key
- Ensure the interactions URL uses HTTPS
- Check that the endpoint returns a PONG for Discord's verification ping

### Slack: "Invalid signature"

- Verify `SLACK_SIGNING_SECRET` matches your app's signing secret
- Check that your server's clock is synchronized (signatures have a 5-minute window)

### Telegram: Bot not responding

A bot has one webhook destination. Reusing its token on another Tau instance
replaces the destination; disabling that copy may delete the shared webhook.
Use separate bots for separate instances.

- Check webhook is registered: `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`
- Verify `TELEGRAM_WEBHOOK_SECRET` matches what you set in `setWebhook`
- Verify `TELEGRAM_BOT_ID` matches `botId` in your channel config
- Check logs for webhook verification errors

### Commands not appearing

- For Discord: Wait up to 1 hour for global commands, or use `DISCORD_GUILD_ID` for instant guild updates
- For Slack: Reinstall the app to your workspace
- For Telegram: Commands work immediately after webhook is set

### "This server/workspace is not configured"

- Create the routing entry under **Settings → Integrations → provider → Channel routing**
- For YAML-managed entries only, restart Tau to sync the configuration
- Verify the `guildId`/`teamId`/`botId` matches the platform

## Architecture

The ingress contract is implemented in `apps/core/src/channels/handler.ts`, the Discord gateway, and `apps/core/src/services/channel-access.ts`.

## Notifications

Send high-signal squad notifications to Discord, Slack, or Telegram channels
when work streams complete or need review. Notifications reuse the same bot
configured for slash commands — no separate webhooks needed. Blocked events
require an explicit custom rule.

**Prerequisites:** the channel bot must already be connected ([Discord](#discord),
[Slack](#slack), [Telegram](#telegram)).

### Option 1: Use slash commands (easiest)

From a channel where your bot is present, after authorization for its routed squad:

```
/tau notify <squad-name>
```

This configures the current channel to receive notifications for its routed squad. Other squads must be configured from Tau. To
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
