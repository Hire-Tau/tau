---
name: setup-linear-integration
description: Set up Linear through Tau Integrations, assign accounts to squads, and configure issue routing or workflow triggers.
---

# Setting up Linear

Help the user configure **Settings → Integrations → Linear**. Credentials are managed there, not in Secrets & Keys. Never ask the user to paste a private API key or signing secret into a chat.

1. Enable Linear globally. Add an account name and personal API key. In Linear, create the key under Security & Access, with read access to the intended teams.
2. Validate and enable the account. An imported legacy account starts disabled and needs validation before use.
3. Open the squad’s **Integrations → Linear** card, enable it for the squad, and select the account. Configure the Linear team IDs whose assigned issues should notify this squad’s manager.
4. Expand **Webhook delivery** in global Linear settings. Copy its URL into a Linear webhook configured for Issue updates. Enter the same signing secret in Linear and Tau. Saved signing secrets cannot be revealed; replace both to rotate.
5. Check `tau webhook status linear` and assign an issue to the connected account’s user. Tau checks that the connected account can read the issue, belongs to the expected team, and is still the assignee before routing it.

No separate `LINEAR_USER_ID` is needed: identity comes from the connected API key. Multiple squads may select the same connection, or choose separate accounts.

## Routing and flows

Existing team routing remains available:

```bash
tau squad set-meta <squad-id> linear '[{"teamId":"team-id"}]'
```

Only a squad with an enabled, assigned Linear connection receives these events. For declarative routing, use the integration output `linear / issue.assigned / version 1` in workflow subscriptions or squad event triggers. Match `issue.id`, `teamId`, or `assignee` as needed. A handled flow event does not also produce the legacy manager notification for that squad.

For live issue search, enable the squad’s Linear connection. Memory grants may further restrict team keys, but cannot grant access beyond the connected account. To run an external command with the selected key, use `tau integration exec linear --squad <id> -- <command>`; credentials are injected for that command and should never be printed.

Troubleshoot in order: global enable, account validation and enable, squad enable and assignment, team routing, webhook signing secret, and current issue assignee.
