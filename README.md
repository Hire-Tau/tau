# Tau

Tau is a platform where AI agent squads work autonomously on goals you define.
Squads consist of manager and worker agents that coordinate via work streams,
inbox messages, and schedules. Humans can monitor, intervene, and collaborate
via a chat UI or CLI.

**Get running now:**

```bash
curl -fsSL https://hiretau.ai/cli/setup.sh | bash
```

That is the whole install — details and the other paths are under [Install](#install).

## Contents

- [What Tau does](#what-tau-does)
- [Install](#install)
- [Quick start (from a checkout)](#quick-start-from-a-checkout)
- [Documentation](#documentation)
- [Architecture](#architecture)
- [Tau Cloud](#tau-cloud)
- [Contributing](#contributing)
- [License](#license)

## What Tau does

- **Squads and work streams** — teams of a manager plus specialized workers; each deliverable is one work stream that moves between agents by reassignment, with dependencies, handoffs, and mandatory review. → [docs/wiki/README.md](docs/wiki/README.md)
- **Autonomous execution with humans in the loop** — agents run on the Pi SDK with file-based persistent sessions; you can steer, stop, resume, and message a running agent, schedules spawn work on an interval or cron, and the UI follows along live over WebSocket. → [docs/wiki/agents-and-executions.md](docs/wiki/agents-and-executions.md), [docs/wiki/event-emitter.md](docs/wiki/event-emitter.md)
- **Subagents and model failover** — ephemeral scoped agents for parallel investigation, and automatic provider/model fallback when one hits a rate limit. → [docs/wiki/agent-runners.md](docs/wiki/agent-runners.md), [docs/wiki/provider-auth.md](docs/wiki/provider-auth.md)
- **Memory** — squad-shared, Obsidian-compatible knowledge retention with hybrid vector + keyword search. → [docs/wiki/memory/README.md](docs/wiki/memory/README.md)
- **Sandbox runtimes** — agent work runs on the host, in Docker containers, in K8s pods, or on per-agent VM boxes. Required choice, no default. → [docs/wiki/sandbox-runtimes.md](docs/wiki/sandbox-runtimes.md)
- **Browser tools** — agents drive a real browser, including on the host runtime with a locally installed Chrome. → [docs/wiki/host-runtime.md](docs/wiki/host-runtime.md#browser-tools)
- **Chat channels and concierge** — Discord, Slack, and Telegram slash commands answered by a read-only concierge agent that forwards real requests to squad managers. → [docs/wiki/channels.md](docs/wiki/channels.md)
- **Notifications** — web push, native iOS push, and channel notifications when a work stream finishes, needs review, or an agent is blocked. → [docs/wiki/notifications.md](docs/wiki/notifications.md)
- **Webhooks** — GitHub and Linear events routed to squads (PR feedback, terminal CI conclusions, issue assignment), plus optional auto-deploy on push. → [docs/wiki/webhooks.md](docs/wiki/webhooks.md)
- **App deployments** — agents run and expose the app they are working on so you can look at it. → [docs/wiki/deployments.md](docs/wiki/deployments.md)
- **Machines and remote hosts** — a fleet of VMs, either your own SSH targets or provisioned for you, hosting sandbox boxes. → [docs/wiki/machines/runtime.md](docs/wiki/machines/runtime.md), [docs/wiki/remote-hosts.md](docs/wiki/remote-hosts.md)
- **Mobile app** — an iOS companion for squad chats, the Action Center, and native push. → [docs/wiki/mobile-app.md](docs/wiki/mobile-app.md)
- **Assistant** — search work, browse squad conversations, and ask in text or live voice; the Realtime assistant can delegate deeper work to a User Assistant. → [docs/wiki/voice-assistants.md](docs/wiki/voice-assistants.md)
- **Federation (AMTP)** — signed agent-to-agent mail between Tau instances and other AMTP nodes. → [docs/wiki/amtp.md](docs/wiki/amtp.md)
- **CLI and REST API** — every operation the UI can do is scriptable, and the same `tau` CLI is installed inside every sandbox for agents to use. → [docs/wiki/cli/README.md](docs/wiki/cli/README.md)
- **Multi-user access control** — passkey sign-in, roles, and permission-gated routes. → [docs/wiki/core-auth.md](docs/wiki/core-auth.md), [security boundaries](docs/wiki/security-boundaries.md)
- **Tau Cloud** — managed hosting at [hiretau.ai](https://hiretau.ai).

## Install

### Run Tau on this machine

```bash
curl -fsSL https://hiretau.ai/cli/setup.sh | bash
```

That installs the `tau` CLI into `~/.tau/bin`, clones the repo to `~/.tau/tau`,
and runs `bun run setup` — which writes `.env`, starts PostgreSQL, migrates,
builds, prepares your sandbox runtime, and starts the API and worker under the selected supervisor.
It asks one question (where agents should run) and prints a URL when it is done.
`curl` and `git` must already be present; everything else is installed for you.

Full walkthrough, flags, headless use, and troubleshooting:
**[docs/wiki/setup.md](docs/wiki/setup.md#local-setup)**.

### CLI only

Install just the released Tau CLI, to talk to an instance running elsewhere:

```bash
curl -fsSL https://hiretau.ai/cli/install.sh | bash
```

The installer writes the CLI to `~/.tau/bin/tau` and bundled CLI assets to
`~/.tau/share`. To reinstall or upgrade later, run `tau install`. Add Tau to
your `PATH` if needed:

```bash
export PATH="$HOME/.tau/bin:$PATH"
```

### Claude Code skill (operate Tau from Claude)

If Claude Code (or any Claude session with skills support) will supervise this
Tau instance — reviewing work streams, unblocking squads, administering the
deployment — install the bundled operator skill. It teaches Claude the
work-stream lifecycle, manager-coordination patterns, remote-host flow, and the
operating doctrine that avoids known failure modes:

```bash
curl -fsSL https://raw.githubusercontent.com/Hire-Tau/tau/main/contrib/claude-skills/install.sh | bash
```

Or from a checkout: `bash contrib/claude-skills/install.sh`. Skills land in
`~/.claude/skills/` (override with `CLAUDE_SKILLS_DIR`); re-run any time to
update.

## Quick start (from a checkout)

```bash
git clone --recurse-submodules https://github.com/Hire-Tau/tau.git
cd tau
bun install
bun run setup
```

Open the URL setup prints, sign in with the `TAU_PASSWORD` it wrote to `.env`,
and register a passkey — the first passkey becomes the system admin. Then sign
in to a model provider under **Settings > AI Providers** and create a squad.
Details, including the CLI login and optional keys:
[docs/wiki/setup.md → After setup](docs/wiki/setup.md#after-setup).

A second tau on the same machine is one flag in its own checkout —
`bun run setup -- --instance <label> --port 3100` names its services, database
container, ports and data root apart from the first
([docs/wiki/setup.md → Multiple instances](docs/wiki/setup.md#multiple-instances)).

Day to day:

```bash
tau server status     # instance, supervisor, root, port, runtime, commit, process states, health
tau server list       # every instance installed on this machine (* marks the default)
tau server logs -f    # tail the api and worker
tau server update     # pull and rebuild this install

tau server use smoke                 # make `smoke` the instance bare commands act on
tau server status --instance smoke   # or name one per command; --instance always wins
```

`tau server install --root ~/.tau/instances/smoke --instance smoke` clones and
sets up a second instance from scratch without touching the first.

To hack on Tau itself, run it from source with `bun run dev` instead — see
[docs/wiki/development.md](docs/wiki/development.md), and
[AGENTS.md](AGENTS.md) for the code conventions.

## Documentation

| Doc                                                                                | What it covers                                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [docs/wiki/setup.md](docs/wiki/setup.md)                                           | Every way to get a running Tau, plus verification and troubleshooting |
| [docs/wiki/README.md](docs/wiki/README.md)                                         | Architecture and primitives — the starting point for contributors     |
| [docs/wiki/sandbox-runtimes.md](docs/wiki/sandbox-runtimes.md)                     | Choosing `TAU_SANDBOX_RUNTIME` and what each runtime needs            |
| [docs/wiki/hosting.md](docs/wiki/hosting.md)                                       | Where the core runs × which sandbox runtime it uses                   |
| [docs/wiki/configuration.md](docs/wiki/configuration.md)                           | `.env` reference, environment variables, API and CLI authentication   |
| [docs/wiki/development.md](docs/wiki/development.md)                               | Dev prerequisites, the `bun run dev` loop, scripts, tests, local k3d  |
| [scripts/setup/README.md](scripts/setup/README.md)                                 | Production toolkit: provision and configure a Linux VM end to end     |
| [docs/wiki/k8s/deployment.md](docs/wiki/k8s/deployment.md)                         | Kubernetes deployment, manifests, storage classes                     |

## Architecture

```
apps/
  core/      Hono + Bun backend (REST API, WebSocket, Pi SDK agent sessions)
             Separate worker process for agent execution
  web/       Vite + React frontend (squad dashboard, chat UI)
  cli/       Commander.js CLI (used by humans and by agents inside sandboxes)
packages/
  shared/    TypeScript types and Zod schemas shared across all packages
config/
  agent-types/     YAML agent type definitions (prompts, models, tools, skills)
  squad-presets/     YAML squad preset definitions (agents, schedules, instructions)
  skills/          Skills materialized into agent sandboxes
  channels/        Discord/Slack/Telegram channel instances
  notifications/   Notification routing rules
  webhooks/        Webhook actions (GitHub, Linear)
```

Those YAML directories are synced into the database on startup, so the building
blocks are editable in the UI but versioned in git. The full map — every
package, the primitives, the worker loop, agent runners, the glossary — is in
[docs/wiki/README.md](docs/wiki/README.md).

## Tau Cloud

[Tau Cloud](https://hiretau.ai) provides managed Tau hosting. This repository contains the complete self-hosted server, web app, CLI, sandbox runtimes, and shared client libraries.

## Contributing

Contributions are welcome! Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.

Tau requires all contributors to sign a [Contributor License Agreement](CLA.md). The CLA Bot GitHub Action will prompt you on your first PR and walk you through the one-comment signing flow. The CLA grants Intentional Design LLC the right to dual-license your contributions; the open-source version of Tau will always remain `AGPL-3.0-only`.

## License

Tau is licensed under the **GNU Affero General Public License v3.0 only** (SPDX: `AGPL-3.0-only`). See [LICENSE](LICENSE) for the full text.

Copyright (C) 2026 Intentional Design LLC

The AGPL is a strong copyleft license. In particular, if you modify Tau and make the modified version available to users over a network, you must also offer them the corresponding source code of your modified version under the same license. If that's incompatible with your use case, please reach out to discuss alternative licensing.
