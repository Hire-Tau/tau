# GitHub account connections

GitHub accounts live in the integration connection pool. Open **Settings → Integrations → GitHub → Settings → Connect account**. Authorize the account, and install the GitHub App on the repositories that Tau should access. Account authorization alone does not give the app repository access.

For Tau's app, choose **Grant repository access** in the same settings card, or open the [public installation page](https://github.com/apps/tau-integration/installations/new). Select your personal account or organization and the repositories to grant access to. You do not need access to the app's developer settings. If GitHub offers **Request** instead of **Install**, an organization owner must approve the request before private repository access works. Existing installations can be changed through **Manage GitHub App installations**. If using a custom GitHub App, install that app instead.

Standalone instances use device login with Tau's public app client ID. Enter the displayed code at GitHub; Tau stores the resulting credential locally, encrypted in its secret store. No private app credential or manual personal access token is needed. Hosted instances use the Platform OAuth broker and return to the tenant after authorization.

## Squad accounts and operation selection

In a squad's **Integrations** settings, attach the accounts it can use and choose a default. Changing the default retains the other attached accounts. Detaching the default does not silently select another identity.

```sh
tau integration connect github
tau integration list --provider github
tau integration assign github --squad <squad-id> --connection <connection-id>
tau integration assign github --squad <squad-id> --connection <another-id> --additional
tau integration exec github --squad <squad-id> --connection <another-id> -- gh pr list
tau integration unassign github --squad <squad-id> --connection <connection-id>
```

Squad shells resolve the default account when `gh` runs or Git requests HTTPS credentials for github.com. Credentials are fetched for each operation, so refresh, disable, and detach take effect without restarting an agent. Local Git operations such as status, diff, and commit do not require a connection. Scripts that intentionally bypass shell functions can use `tau integration exec` explicitly.

The execution endpoint requires squad-scoped `integrations:use` permission. Connection IDs do not grant access: the requested account must be attached to that squad, enabled, and currently authenticated. Ordinary list/settings responses never contain credentials.

For completion checks, set `github.connectionId` in work-stream metadata to select an attached account, or omit it for the squad default. Flow subscriptions and squad event triggers can set `source.connectionId`. Repository and PR metadata establish polling interest; they do not grant repository access. Polling cursors include the connection identity, and normalized outputs retain it through delivery. Signed webhook ingress verifies repository access before attributing an event to a connection.

## Refresh and disconnect

Tau refreshes expiring user tokens centrally. GitHub refresh invalidates the previous pair, so Tau saves the replacement before validating account identity. A failed identity check disables access; a transient provider failure preserves the replacement refresh token for recovery. Each connection remains bound to its issuing app configuration even after an operator changes the default app.

Disconnect removes access in Tau. GitHub requires a client secret for remote revocation; public-client device logins cannot perform that step automatically. To revoke the authorization on GitHub, open **GitHub Settings → Applications → Authorized GitHub Apps**. Removing an installation affects its repository access separately.

Legacy `GH_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN_*`, `GITHUB_TOKEN_*`, `GITHUB_USER`, and squad `githubTokenSecretKey` configuration are retired. Reconnect accounts through Integrations. Stored historical values are not automatically deleted. Git commit author overrides remain separate from the account used to authenticate.

## App configuration

The default public client ID is `Iv23liN16iuEh5lT1PYV`. In a standalone instance, expand **Use your own GitHub App** to configure another public client ID. An optional client secret enables browser authorization; use the callback URL displayed in settings. Existing connections retain their issuing app reference.

Enable device flow and expiring user authorization tokens. Leave “Request user authorization during installation” unchecked so Tau initiates authorization with bound state. Configure repository permissions: Contents, Pull requests, Issues, Actions, and Workflows read/write; Checks, Commit statuses, and Metadata read-only. Users choose which repositories to install the app on.

Tau uses user access tokens. GitHub App ownership still permits the owner to generate a private key and obtain installation tokens independently; this design does not remove that GitHub capability. Operators who want to control the app themselves can use the custom-app option.

App-level webhooks are optional: Tau continues polling repositories referenced by flow bindings and work-stream metadata. Existing tenant-specific signed webhooks remain supported.

### Automatic delivery for managed cloud instances

Managed instances automatically register exact repositories found in unfinished work-stream metadata, GitHub flow subscriptions, squad GitHub Routing repositories, and squad integration triggers. Repository matches can use literals or work-stream metadata bindings; triggers without a repository match use the squad's declared GitHub repositories. This does not enumerate every repository a connected account can see. Install the App on the relevant repositories and assign a GitHub connection to the squad. No tenant webhook URL or signing secret is needed.

Core consumes Platform's durable queue every five seconds (up to four connections per tick), using its instance credential. Platform checks that the supplied user token belongs to the shared App and still has repository and access to the specific event resource before releasing any payload. Events whose underlying resource is no longer readable are discarded; this does not remove the subscription to other events from that repository. Core then rechecks the connection revision, squad assignment, and declared interest. Events enter the same typed integration outputs used by polling; existing flow subscriptions select recipients, triggers can create work, and native squad routing handles assignments, mentions, and review requests. Relay events do not run legacy instance-wide webhook shell rules. Direct tenant webhooks still support those rules.

Subscriptions renew every five minutes and expire after 24 hours offline. Encrypted payloads and delivery receipts expire after 72 hours; acknowledged payloads are cleared earlier. A lost acknowledgment retries after a two-minute lease, and output fact keys deduplicate flow consumption. Each connection supports up to 100 exact repositories, with 100 connections per tenant and a tenant budget of 3,600 relay GitHub API requests per hour. Empty queue polls make no GitHub API calls.

GitHub does not automatically retry a failed webhook request to Platform. Operators can redeliver from the App's delivery log; provider polling remains the fallback for missed events and Platform downtime. Payloads over 1 MiB are rejected. Self-hosted instances do not consume the managed queue: they use polling or their own signed webhook endpoint.

## Instance updates and GitHub Pages

GitHub Pages uses the same squad connection; the old `DEPLOY_GITHUB_PAGES_TOKEN` is retired. Pages API configuration requires Pages write permission on the app, or a human can configure Pages directly in GitHub. Actions workflows can deploy with their own repository-scoped workflow token.

For privileged local Tau updates, the updater uses the sole usable GitHub connection. With multiple accounts, set `githubConnectionId` in the update settings API to select one explicitly. It never falls back to the host's `gh auth login` credentials.

## Direct webhook delivery

In **Settings → Integrations → GitHub → Webhook delivery**, copy the webhook
URL and generate or enter a signing secret. Copy the new secret into your own
GitHub App's webhook settings (or a repository webhook), then save it in Tau.
Use JSON delivery and subscribe to the events your flows consume. Your public
`APP_URL` must point to this instance; path prefixes are included in the displayed
URL. The receiver is `/api/webhooks/github` beneath that public base path.

Signing secrets are encrypted under integration-owned storage, never returned
by the settings API or exposed to squads. You can replace the secret or disable
direct webhooks here without restarting Tau. Disabled direct delivery does not
disable polling or a managed platform relay.

Existing `GITHUB_WEBHOOK_SECRET` database/environment values are imported on
startup. Once imported, use integration settings for changes and remove the old
environment entry. Rotation and explicit disable survive restarts even if that
old variable remains. Legacy secret APIs no longer expose or modify this setting.
An encryption key must be configured for the import and integration settings.
The Platform's shared-App `GITHUB_APP_WEBHOOK_SECRET` remains a Platform setting,
independent of each instance's optional direct webhook receiver.

## Squad event routing

Under **Squad settings → Integrations → GitHub → Event rules**, choose an event, account, repository/label filters, and action:

- **Notify manager:** send the event to the squad’s manager.
- **Notify new consultant:** start a fresh consultant chat for the event, with the same squad context as a manager chat. Retrying delivery reuses that chat.
- **Create work stream:** save a selected workflow, or the squad default, paused for owner preparation. The event’s repository and issue/PR references are attached automatically; a Git checkout is prepared separately before resume. Existing bound work is reused.
- **Ignore:** take no squad action.

A repository filter is an exact `owner/repository`, or a pattern with `*`
(`owner/*`, `owner/svc-*`). Patterns match incoming events directly, and they
also establish polling watches and hosted-relay subscriptions: the pattern is
expanded against the repositories the selected account can see (`GET /user/repos`
under that account, listed once per connection and refreshed every ten minutes
or when the account reconnects), and each match is watched exactly once even
when several rules or squads overlap. Expansion fails closed — a pattern that
matches more than 100 repositories, or whose account is revoked or has no
usable credential and no cached listing, establishes no watches and is
recorded as a `repository_pattern_expansion` integration audit event and a
worker log warning; exact filters on the same account are unaffected.
Repositories that stop being visible or stop matching drop out on the next
discovery cycle.

The **Shared repository scope** is a reusable filter, not an action. A rule with **Use shared repository scope** enabled must match one of those repository entries **and** its own filters. Shared labels apply only to issue assignment/unassignment events and match any listed label; comments and PR events use only the shared repository restriction. When the checkbox is off, the shared scope is ignored. Blank rule filters add no restriction; rule labels match any listed label on the issue or PR. All access still comes from the assigned integration account.

**Account involvement** selects how the event relates to the selected connection:

- **Assigned account or requested reviewer**: for issue assignment/unassignment, the affected person must be that account; for review requests, the account must be requested (team review requests delivered to the connection also match). For other events, use the same assignee/mention check below.
- **Account is assigned or @mentioned**: the account is an assignee on the issue/PR or appears as an @mention in the event text. Events authored by that account or a bot are ignored.
- **Any matching event**: no assignment or mention check, including self-authored and bot events. The other filters still apply.

With any account selected, one attached account matching is enough. **Notify manager**, **Notify new consultant**, and **Create work stream** accept optional **Instructions**, included as instructions from the squad’s event rule alongside the external event details. For example, tell the manager to create an engineering workflow for the issue, prepare an isolated worktree, and then start it. Updating instructions affects future events, not previously delivered messages or existing work streams.

**Create work stream** saves the chosen workflow in a queued, paused stream and notifies its owner (the squad manager). No worker agents are spawned and no admission slot is consumed during preparation. The owner reviews the event, attaches a workspace if needed using `tau workstream update <id> --repository <checkout-path>`, and runs `tau workstream resume <id>` to start it under the normal concurrency limits. Tasks without a Git workspace can be resumed after review. If the squad has no manager, an operator must prepare and resume the stream. Repository replacement after workflow agents have started remains prohibited.

The first matching enabled rule wins. Move rules up or down to set priority. Deleting every rule disables squad actions for that provider. Events already bound to a work stream still follow its own subscriptions, including pause and wait behavior; squad rules do not override them. Changing rules does not replay already handled events.

If a previously started work stream is parked, subscribed events such as a PR merge are retained for its workers and also sent once to its current owner. The owner can review the event and explicitly resolve any wait whose condition is satisfied. This notice does not approve, finish, resume, or clear waits automatically, and does not start parked workers. Ownership determines the recipient, even when the owner is not the squad manager. Explicit pauses and never-started streams continue holding events. If no owner is available, or the owner is itself part of the parked crew, the delivery history explains the hold rather than substituting the manager.

Existing repository/team routing and saved event triggers appear as editable rules on upgrade. No notification shell scripts are needed. Squad update permission is required to save rules. The CLI/API can also update `metadata.integrationRules.github` or `metadata.integrationRules.linear` on a squad. Each ordered rule has an `id`, `enabled`, `source` (`integration`, `output`, `version`, optional `connectionId`), `filters`, and one of the four `action.type` values: `notify-manager`, `notify-consultant`, `start-workstream`, `ignore`. The start action’s optional `workflow` uses the same preset/inline reference as work-stream creation.

A squad must have an assigned, usable connection with access to the event resource. Exact repositories in routing or rules declare relay and issue-polling interests. Wildcard patterns filter received webhooks but do not enumerate an account’s repositories. New PR review requests need webhook/relay delivery; polling follows already tracked PRs and issue assignments. Linear currently supplies issue-assignment events. Additional providers can supply their own event adapters while using the same actions.

### Follow an attached issue

With **Code hosting** enabled, a work stream automatically subscribes to comments, updates, assignments, and unassignments for the issue recorded in `github.repo` and `github.issue`. Event-created streams already receive these metadata fields. The issue number can be a positive integer or a decimal string. Manually created streams can attach an issue by setting the same metadata; merely mentioning its URL in the description does not attach it.

Issue events use the same recipient setting and retained-delivery rules as PR events. Active workflows deliver to their configured recipient; parked started workflows can notify their owner while retaining worker delivery; explicit pauses and never-started workflows stay held. The issue may coexist with a PR binding in the same repository. Attaching a PR does not remove the issue subscription.

Set `github.connectionId` to choose an attached account explicitly. Otherwise the code-host connection, or the original event's connection when it refers to this issue, pins routing; without a pinned connection, normal squad authorization applies. Removing or rebinding the issue invalidates pending delivery. Disabling **Code hosting** disables inferred PR and issue subscriptions; explicit workflow subscriptions remain available. Squad manager rules remain fallbacks and do not override a linked stream's subscription settings.
