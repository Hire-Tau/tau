---
name: frontend-visual-review
description: Use when previewing a UI, capturing screenshots, or iterating visually on frontend work. Covers hosting a dev server in the sandbox, opening it with the browser tools, and reading console/console-error output.
---

# Frontend Visual Review

## When to use

- Building or changing any UI (HTML/CSS/JS, React, Vue, etc.) that benefits from being _seen_.
- Validating a bugfix that has a visible symptom (layout, color, missing element, broken click).
- Producing screenshots for review or design discussion.

**Do not** use this skill for headless logic/unit tests — keep those in your test runner.

## Prerequisites

- The `browser_*` tools (`browser_open`, `browser_click`, `browser_type`, `browser_scroll`, `browser_screenshot`, `browser_read`, `browser_console`) are available in your agent type.
- `APP_URL` env var is set in the sandbox (it is, for every Tau squad — see the Platform URLs section of your system prompt).
- A working dev server command (e.g. `bun run dev`, `npm run dev`, `python3 -m http.server`).

## Command runtime

Run every command in this skill with `squad_bash` from the project worktree. Start the server, localhost probe, `tau deploy local` commands, and diagnostics in that same shared runtime: a local deployment cannot reach a server started in private `bash`. If `squad_bash` is unavailable, **do not** start or attach a local app from private `bash`: delegate the shared-runtime server/deployment operation to an agent that has it. Use an available shell only for operations its Workspace & Sandbox prompt says can reach the required project/runtime.

## The 5-step loop

1. **Start the dev server** bound to `0.0.0.0` so the sandbox's local-deployment proxy can reach it.
2. **Register it as a Tau local app** so it gets a public, token-protected URL.
3. **Open it** with `browser_open`.
4. **Screenshot / read / interact** with the other `browser_*` tools.
5. **Iterate** — edit code, the dev server hot-reloads, repeat steps 3–4.

## Steps 1–2: Start a managed Tau local app

Use the project's server command, but let Tau supervise it and assign `$PORT`. The command must bind to `0.0.0.0` and honor `$TAU_APP_BASE_PATH`. Use a unique `RUN_NAME` per project.

```bash
SQUAD_ID=<your-squad-id> # from `tau workstream get <id> --json`
RUN_NAME=<unique-project-name>

# Vite/React example (run through squad_bash)
tau deploy local start "$SQUAD_ID" \
  --name "$RUN_NAME" \
  --cwd "$PWD" \
  --command 'bun run dev -- --host 0.0.0.0 --port $PORT --base $TAU_APP_BASE_PATH'

# Then derive the browser URL.
DEPLOYMENT=$(tau deploy local list "$SQUAD_ID" --json | jq -r '.[] | select(.name==env.RUN_NAME) | .urlPathOrHost' | head -1)
PUBLIC_URL="${APP_URL%/}${DEPLOYMENT}"
echo "$PUBLIC_URL"
```

For other frameworks, adapt only `--command`; keep the managed launch, bind address, assigned `$PORT`, and base-path support. Managed local apps are supervised and restartable conveniences, not a durability mechanism for one-shot builds, migrations, tests, or generation jobs.

Verify reachability from your sandbox:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" "$PUBLIC_URL"
# Expect 200 (or whatever your route returns; never 404 from the proxy).
```

## Step 3: Open it with `browser_open`

Call `browser_open` with `$PUBLIC_URL`. The browser tool runs on the Tau host (Playwright Chromium, headless) and reaches your sandbox via the `/api/app/<id>/` proxy. The output reports the resolved page title and an attached screenshot.

If you see `ERR_CONNECTION_REFUSED` or a timeout, you almost certainly tried to point the browser at `127.0.0.1` or a sandbox-internal IP. Use the `$PUBLIC_URL` you derived above — nothing else is reachable.

## Step 4: Capture / inspect / interact

- `browser_screenshot` — capture the current viewport. Useful before _and_ after a change so you can compare.
- `browser_read` (optional `selector`) — extract visible text; good for asserting expected copy without parsing the screenshot.
- `browser_console` — returns the most recent ~50 console entries (`log`, `info`, `warn`, `error`). **Always check this when something looks off** — bundler errors and React warnings show up here.
- `browser_click({ selector | x, y })`, `browser_type({ text, selector? })`, `browser_scroll({ direction, amount? })` — drive simple interactions for multi-screen flows.

## Step 5: Iterate

Most dev servers (Vite, Next.js, Remix, etc.) hot-reload on file change. After editing, re-run `browser_open` (or `browser_screenshot` on the same page) and compare. If the change didn't take effect, hard-reload by re-calling `browser_open` on the same URL — the browser session is reused per agent run, so this re-navigates the existing page.

## Saving screenshots for handoff

`browser_screenshot` already attaches the image to your tool response, which is what reviewers and humans see. If you want a persistent copy you can reference later:

```bash
# After a screenshot call, the image is part of your tool result. To save one
# explicitly, take it with Playwright via a short script if needed. For most
# review handoffs, attaching the tool response is enough — do not over-engineer.
```

To put a saved screenshot on a PR or issue, use `gh pr comment <n> --attach ./shot.png`
(repeat `--attach` for several files; alt text follows the path after `#`).

## Cleanup

When you're done iterating, archive the local app so the Apps tab stays clean:

```bash
tau deploy local archive <deployment-id>
```

## Troubleshooting

| Symptom                                                     | Cause / fix                                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `browser_open` returns `ERR_CONNECTION_REFUSED` or timeout. | You're pointing at `localhost`/`127.0.0.1` or a sandbox-internal IP. Use `${APP_URL}${urlPathOrHost}` — the browser runs on the Tau host, not in the sandbox.      |
| Page loads but is blank/white.                              | Check `browser_console` for JS errors and bundler messages first. Then verify the dev server actually serves index.html at `/` (some frameworks need a base path). |
| Auth-walled app (login redirect, etc.).                     | Either point at a public route or seed cookies via a `browser_open` to a login URL followed by `browser_type`/`browser_click`.                                     |
| Old screenshot is reused.                                   | Browser session is per-run. Call `browser_open` on the same URL to force a fresh navigation, or scroll to top with `browser_scroll`.                               |
| Squad has hit the local-deployment limit.                   | `tau deploy local list --include-archived` then archive stale ones with `tau deploy local archive <id>`.                                                           |

## See also

- `deploy-app` — broader app deployment skill (covers external providers).
- `apps/core/src/tools/browser.ts` — source of truth for `browser_*` tool parameter shapes.
