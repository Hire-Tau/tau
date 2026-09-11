# Sanitized GitHub polling fixtures

These preserve recorded GitHub response shapes, including keys, value types, nulls, casing and matching REST/webhook fields. Repository and user identities, numeric and node IDs, URLs, refs, commit SHAs, timestamps and prose are synthetic. They do not contain private PR/comment content.

- `github-issue-comment-rest.json` preserves matching PR, issue and issue-comment REST responses. Its matching issue-comment webhook is `services/webhooks/processors/fixtures/github-issue-comment-webhook.json`. The regression compares their normalized payloads. The `private` flag is deliberately retained as API shape coverage; the named repository is fictitious.
- `github-pull-request-review-rest.json` preserves a review response and REST's uppercase `COMMENTED` state.

Treat `_recording` endpoint/ID values as synthetic fixture references, not links to original deliveries. Never replace these with raw production captures.
