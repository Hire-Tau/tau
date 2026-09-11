---
name: view-system-logs
description: "View Tau server system logs (API and worker) via the CLI. Requires the system:logs permission scope. Use when diagnosing server-side errors, worker failures, or runtime behavior."
required-permission: system:logs
---

# View System Logs

## When to Use

Use this skill to inspect Tau's own server logs — the API (core) process and
the worker process — when diagnosing server-side errors, failed background
jobs, webhook delivery issues, or unexpected runtime behavior. This skill only
appears for agents that hold the `system:logs` permission scope.

## CLI Usage

Stream system logs with `tau system logs`:

```bash
tau system logs                              # all components, follow live, last 500 lines
tau system logs -c api                       # API/core logs only
tau system logs -c worker                    # worker logs only
tau system logs -c all -t 1000               # last 1000 lines, all components
tau system logs --no-follow                  # one-shot tail, then exit
tau system logs -c api -t 200 --no-follow    # snapshot of last 200 API lines
```

## Options

- `-c, --component <component>` — `api`, `worker`, or `all` (default: `all`).
- `-t, --tail <n>` — number of recent lines to load first (default: `500`,
  clamped server-side to a maximum of `5000`).
- `-f, --follow` — follow live logs (default: on).
- `--no-follow` — disable following; print the tail and exit.

## Output

Binary frames carry raw log chunks written straight to stdout; JSON control
frames report `{ type: 'info' | 'error', message }`. On a non-follow tail the
stream closes with an `info: Tail complete` message.

## How Access Is Granted

This skill is gated by `system:logs`. An admin grants it to a specific agent
with:

```bash
tau agent scope grant <agent-id-or-name> system:logs
```

Once granted, the skill appears in that agent's available skills automatically
on its next session after the normal skill cache refresh.

## Reference

- Endpoint: `GET /ws/system/logs` (WebSocket; query params: `component`,
  `tailLines`, `follow`).
- Server-side handler: `apps/core/src/services/ws/system-logs.ts`.
- Only the logical components `api`, `worker`, and `all` are accepted; concrete
  log file paths are resolved server-side and never exposed.
