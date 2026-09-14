# Ownership document conventions

Ownership documents are Markdown files under `/memory/ownership/*.md` that provide canonical routing evidence for squad suggestions.

See also [semantic routing](../../routing/semantic-routing.md) for how this evidence is scored and surfaced to consultants.

## Frontmatter contract

```yaml
---
kind: ownership
title: Billing squad ownership
domain: billing
squadIds: ['sq_01H...']
repos: ['acme/billing']
channels: ['C0123']
tags: [refunds, invoices]
sourceLinks:
  - kind: slack_thread
    url: 'https://acme.slack.com/archives/C0123/p1700000000000000'
  - kind: github_issue
    url: 'https://github.com/acme/billing/issues/42'
createdAt: 2026-05-19T00:00:00Z
---
# What this squad owns

Bullet list of domains, products, runbooks. Plain prose body.
```

Required fields:

- `kind: ownership`
- `title`
- At least one of `domain` or `squadIds`

Optional fields:

- `repos`: repository names, usually `owner/name`
- `channels`: Slack channel IDs or other stable channel identifiers
- `tags`: short topic labels used by memory search
- `sourceLinks`: provenance links that justify or explain the ownership claim
- `createdAt` / `updatedAt`: ISO 8601 timestamps

## Routing behavior

The squad suggester scans only `/memory/ownership/*.md` for ownership-specific evidence. A matching ownership document contributes routing evidence in addition to squad purpose and general memory matches.

If an ownership document frontmatter includes `squadIds`, each listed squad ID is treated as an explicit owner when that squad is within the caller's readable candidate set. This is a direct routing signal: the ownership hit is attributed to the named owner squad even when the document lives in another squad's memory vault.

Cross-squad ownership claims must use real squad IDs in `squadIds`, not display names. Names can change and are not used for explicit ownership matching.
