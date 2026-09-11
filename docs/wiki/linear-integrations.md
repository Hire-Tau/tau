# Linear integration

Manage Linear in **Settings → Integrations → Linear**. Enable the integration, create a named account with a personal API key, validate it, and enable the account. Keys can be limited to specific teams in Linear; read access is sufficient for issue search and assignment routing. See [Linear’s API documentation](https://linear.app/docs/api-and-webhooks).

In a squad’s **Integrations** tab, enable Linear and choose an account. Add team IDs to route assigned issues to its manager. Disabling the squad integration preserves the account choice; re-enabling restores it. Global disable preserves all account and squad settings while stopping use.

For webhook delivery, configure an Issue webhook in Linear with the URL shown in the global card and the same signing secret in both applications. Save a signing secret to enable delivery; disabling clears it. Stored secrets are never returned to the browser. Rotate by entering a new value in both places.

The connected account supplies the assignee identity. Tau verifies current issue access, team, and assignee before delivering an event. Workflow subscriptions and squad triggers can consume `linear / issue.assigned / version 1`, with `issue.id`, `issue.title`, `teamId`, and `assignee` fields. When a flow handles the event, the same squad’s legacy team-based manager notification is suppressed.

Live memory search resolves the calling squad’s selected connection. Existing memory grants and team-key filters further restrict search. `tau integration exec linear --squad <id> -- <command>` supplies the selected key to a command without exposing it in CLI output.

On upgrade, a legacy `LINEAR_API_KEY` is imported once as a disabled account. Validate, enable, and assign that account in Integrations. The old webhook secret is moved into encrypted integration settings. `LINEAR_USER_ID` and legacy secret editing are retired. Existing team routing metadata is preserved.
