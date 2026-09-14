# Choosing a sandbox runtime

Every tau install must choose where agent work executes. `TAU_SANDBOX_RUNTIME`
is **required** and takes exactly one of five values — `docker-sysbox`,
`docker-socket`, `k8s`, `vm`, `host`. There is no default and nothing is
detected for you: the api and the worker refuse to start when it is unset or
set to anything else, so a misconfigured deployment fails loudly at boot
instead of silently running agents somewhere nobody chose. This axis is **independent of
where the core itself runs** (local checkout, a single VM built by the setup
toolkit, or the hosted platform) — any combination works. See
[hosting.md](hosting.md) for that second axis.

## Which one do I want?

| Your situation                                                      | Runtime         |
| ------------------------------------------------------------------- | --------------- |
| My laptop; I just want agents working on my own repos, fast         | `host`          |
| My laptop or dev box; I want containers, but macOS or no sysbox     | `docker-socket` |
| A Linux box where I want real container isolation                   | `docker-sysbox` |
| Many agents, multi-tenant, per-agent VMs / the hosted product shape | `vm`            |
| Hard isolation, resource guarantees, or I already run a cluster     | `k8s`           |

## Comparison

| Runtime         | Isolation                                               | Prerequisites                                                                       | Where agents' files live                                      | Not available                                                           |
| --------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `host`          | None — same unix user as the core                       | `bash`; `tmux` for local deployments                                                | The core's own storage dirs (`~/.tau/...`), no copy           | devbox/toolchains, container log streaming, workspace-file memory watch |
| `docker-socket` | Container, but the sandbox holds the host Docker socket | Docker (any host, incl. macOS); sandbox image built                                 | Bind mounts from the core's storage dirs into `tau-sandbox-*` | —                                                                       |
| `docker-sysbox` | Container with user-namespace isolation + real DinD     | Linux + [sysbox](https://github.com/nestybox/sysbox) installed; sandbox image built | Bind mounts from the core's storage dirs into `tau-sandbox-*` | —                                                                       |
| `vm`            | Separate unix user on a separate VM per box             | At least one registered machine (BYO-SSH host or exe.dev credentials)               | On the machine VM, synced/served by the box sandbox server    | —                                                                       |
| `k8s`           | Pod, with scheduler limits and network policy           | A cluster + `KUBECONFIG` (or in-cluster core), storage classes, manifests applied   | PVC subPath mounts on the shared volume                       | —                                                                       |

Nothing on this page changes agent behaviour except where the "Not available"
column says so: every runtime delivers the same per-sandbox asset set (skills,
CLI, ssh, memory) through the shared asset manifest. Browser tools work on
every runtime, including `host`, where the core drives a locally installed
Chrome/Chromium/Edge in-process — see
[browser tools](host-runtime.md#browser-tools).

## Mixing runtimes (design — not yet shipped)

> **Status: approved direction, not yet implemented.** This section
> describes the designed per-squad runtime selection from
> the per-squad runtime design
> (issue #1336). It lands as a phased implementation; until then
> `TAU_SANDBOX_RUNTIME` remains the single process-wide choice.

The design lets **one instance run several runtimes at once**: the instance
default stays `TAU_SANDBOX_RUNTIME`, and a nullable per-squad override
(`squads.runtime`) — plus a solo-agent override (`agents.runtime`, for agents
in no squad) — selects a different runtime for that squad's shared box and
its member agents' boxes, or that solo agent's box. `null` everywhere means
"the instance default", which is the only state existing installs have.

Rules, in user terms:

- **Squad members follow their squad.** An agent in a squad runs its own box
  and the squad's warm box on the squad's runtime; the solo-agent override
  applies only to agents in no squad. Subagents inherit their parent's box
  and runtime.
- **Every runtime in use is validated at startup.** A value nobody can serve
  (unknown spelling, missing docker image, no `bash` for `host`) refuses to
  start, exactly as a bad `TAU_SANDBOX_RUNTIME` does today; cluster/machine
  reachability stays a warning, as today.
- **Per-runtime subsystems run for any runtime in use.** The VM reaper and
  K8s prepull/reconcile loops start when any squad uses that runtime, not
  only when it is the default.
- **Visibility:** the squad and agent sandbox-status endpoints report the
  resolved runtime per sandbox; the system status lists the active set and
  every override.
- **Changing a runtime** with a live box stops the old box and re-ensures on
  the new runtime (the same live-migration the machine pin already does).
  Moves between Docker, host, and K8s keep the shared workspace storage, so
  work survives. Moving **to** `vm` starts a fresh box (uncommitted work in
  the old sandbox does not follow). Moving **from** `vm` with a live box, or
  between K8s and non-K8s storage layouts, is rejected with a 409 rather
  than guessed at — export first or stop the box.
- **Rolling deploys:** set overrides only after both the api and the worker
  run the new code; older processes ignore the columns. Rolling back needs
  no data fix — overridden squads simply return to the default.
- **Hosted operators** can structurally disable mixing with
  `TAU_DISABLE_RUNTIME_OVERRIDE=1`.

## Local quick start (dev checkout)

`bun run setup -- --runtime <host|docker-socket|docker-sysbox|k3d>` does all of
this for a checkout: it writes the runtime and the secrets the UI needs into
`.env`, prepares the runtime (sandbox image or k3d cluster), and starts the
instance — see [docs/wiki/setup.md](setup.md#local-setup). `k8s` and `vm` are not local
installs; their sections below list what they need instead.

Setup writes `TAU_SERVE_WEB=1`, so the whole app is on one port. The
alternative, for hot-reload work on the frontend, is the vite dev server:

- **`TAU_SERVE_WEB`** — to reach the UI from the core itself, run
  `bun run build:web` and start the core with `TAU_SERVE_WEB=1`; the app,
  `/api/*` and `/ws` are then all on `PORT` (3000 by default). `.env.example`
  ships `TAU_SERVE_WEB=1` — `1`/`true`/`yes` force serving on (warning if no
  build exists yet), `0`/`false`/`no` never serve, and leaving it unset serves
  only when a build already exists. The vite dev server (`bun run dev:web`,
  port 5173) is the alternative, but its proxy targets `localhost:3000`
  only — it cannot talk to a core on another `PORT`.

## `host` — no sandbox

Agents run directly on the core's machine as the core's unix user, in the
core's own directories. Zero isolation between agents, and none from the
machine — pick it for a personal machine or a trusted single-user VM.

**Prerequisites:** `bash`; `tmux` if agents run local deployments. No Docker.

```bash
TAU_SANDBOX_RUNTIME=host
```

Setup toolkit: `runtime.sandbox: host`.

Deep doc: [host-runtime.md](host-runtime.md) — what agents see, the
environment snapshot, the security model, the per-squad workspace override, and
the full "Not available on host" list.

### Second instance beside an existing one

This is the hand-wired alternative; the installer's `--instance <label>`
(docs/wiki/setup.md → Multiple instances) does all of this for you, one instance per
checkout.

`host` is the cheapest way to try tau next to an install you already run, but
the two share a machine, so everything they both hold has to be moved apart:

| Knob                       | Why                                                             |
| -------------------------- | --------------------------------------------------------------- |
| `PORT`                     | API/web port (3000 by default)                                  |
| `TAU_WORKER_EVENT_PORT`    | the worker's loopback listener (3003 by default)                |
| `TAU_INTERNAL_EVENT_TOKEN` | must match between _this_ api and worker; give the pair its own |
| `DATABASE_URL`             | its own database                                                |
| `HOME_DIR`                 | its own data root (`~` ok) — agents run on this machine         |
| `APP_URL`                  | so notification links point at the right instance               |

A second database in the same Postgres container, then migrate it:

```bash
docker exec -it $(docker ps -qf name=postgres) psql -U postgres -c 'CREATE DATABASE tau_host_test'
DATABASE_URL=postgres://postgres:postgres@localhost:5432/tau_host_test bun run db:migrate
```

Then build and start it (the same checkout is fine):

```bash
bun run build:cli && bun run build:web && bun run dev:core
```

Put those values in the `.env` the core reads, or pass them inline — an
explicit process env var wins over the `--env-file` `dev:core` loads.

## `docker-socket` — containers on any Docker host

One `tau-sandbox-*` container per sandbox, with the host's Docker socket
mounted in so agents can use Docker. That socket is host-level access: an agent
that can talk to it can escape the container. Use it when you want containers
on macOS, or on a Linux host without sysbox.

**Prerequisites:** a working Docker daemon, and the sandbox image:

```bash
bun run sandbox:build:docker
```

```bash
TAU_SANDBOX_RUNTIME=docker-socket
# TAU_SANDBOX_IMAGE=tau-sandbox:latest   # optional override
```

Setup toolkit: `runtime.sandbox: docker-socket`.

Local install: `bun run setup -- --runtime docker-socket` builds the image and
writes these values for you ([docs/wiki/setup.md](setup.md#local-setup)).

## `docker-sysbox` — containers with real Docker-in-Docker

Same containers, but run under `sysbox-runc`: root inside the container maps to
an unprivileged host user, and Docker-in-Docker works without mounting the host
socket. The strongest Docker-level isolation, and the reason to prefer it over
`docker-socket` wherever it is available. **It never falls back** — if sysbox is
not installed on the host, the core fails with an explicit error rather than
quietly handing agents the host socket.

**Prerequisites:** Linux (kernel 5.12+) with sysbox installed, plus the sandbox
image as above.

```bash
TAU_SANDBOX_RUNTIME=docker-sysbox
# TAU_SANDBOX_IMAGE=tau-sandbox:latest   # optional override
```

Setup toolkit: `runtime.sandbox: docker-sysbox`.

### Installing sysbox

Linux only, kernel 5.12+. The easiest path is the CLI's guarded bootstrap,
which prints the exact plan, requires explicit consent, and verifies
afterwards that docker registered `sysbox-runc`:

```bash
tau server bootstrap-sysbox            # consent-gated; prints the plan first
tau server bootstrap-sysbox --dry-run  # print the plan, change nothing
```

It checks the host first (Linux, x86_64, kernel ≥ 5.12, systemd, docker)
and fails with actionable guidance instead of attempting anything on a host
that cannot run it. **Inside WSL**, sysbox needs systemd, which WSL disables
by default — add `[boot]` → `systemd=true` to `/etc/wsl.conf`, run
`wsl --shutdown` from PowerShell, and reopen the distro before bootstrapping.

The manual recipe it automates (same pinned version), from the
[sysbox releases page](https://github.com/nestybox/sysbox/releases):

```bash
# See https://github.com/nestybox/sysbox/releases for the latest .deb
wget https://downloads.nestybox.com/sysbox/releases/v0.6.6/sysbox-ce_0.6.6-0.linux_amd64.deb
sudo apt-get install -y jq

# ⚠️ Installation removes ALL running Docker containers and restarts dockerd
docker rm $(docker ps -a -q) -f
sudo dpkg -i sysbox-ce_0.6.6-0.linux_amd64.deb

sudo systemctl status sysbox      # verify sysbox is running
docker info | grep -i sysbox      # verify Docker can use it
```

If `sysbox-mgr` fails with `open /proc/modules: no such file or directory`
(some VPS kernels), disable the shiftfs check with a systemd override:

```bash
sudo mkdir -p /etc/systemd/system/sysbox-mgr.service.d
cat <<'EOF' | sudo tee /etc/systemd/system/sysbox-mgr.service.d/override.conf
[Service]
ExecStart=
ExecStart=/usr/bin/sysbox-mgr --disable-shiftfs
EOF
sudo systemctl daemon-reload && sudo systemctl restart sysbox
```

## `vm` — boxes on machine VMs

Each sandbox is a **box**: a dedicated unix user on a registered machine (a
provider VM or a BYO-SSH host), running the same sandbox server the k8s runtime
uses, reached over an SSH tunnel. Boxes pack onto shared machines, park when
idle, and migrate between machines. This is the hosted product's runtime.

**Prerequisites:** at least one registered machine. Either

- **byo-ssh** — any Ubuntu 24.04 host reachable over SSH; tau bootstraps it, or
- **exe** — auto-provisioned exe.dev VMs; store the exe.dev account SSH private
  key in the secret store under `exe-provider-ssh-key` (Settings → Secrets).

Register machines from Settings → Machines in the web UI (or `POST
/api/machines`).

```bash
TAU_SANDBOX_RUNTIME=vm
# TAU_EXE_MACHINE_IMAGE=ghcr.io/hire-tau/tau-machine:latest   # optional; exe provider only
```

Setup toolkit: `runtime.sandbox: vm` (plus `runtime.exe.ssh_key_path` and
`runtime.exe.machine_image` when using exe.dev).

Deep docs: [machines/runtime.md](machines/runtime.md) (lifecycle, placement,
troubleshooting) and [machines/exe-provider.md](machines/exe-provider.md)
(credential, image, cost model).

## `k8s` — sandbox pods in a cluster

One pod per sandbox in a sandbox namespace, with subPath mounts on a shared
PVC, real scheduler limits, network policy, and spec-drift self-healing. This is
the escalation tier: reach for it when a tenant needs hard isolation or resource
guarantees. (The separate track that also runs the _core_ on Kubernetes is
paused — see [hosting.md](hosting.md).) For local development, k3d gives you
the same runtime on one machine.

**Prerequisites:** a cluster with the core running in-cluster or a valid
`KUBECONFIG`, RWX/RWO storage classes, and the manifests in `k8s/` applied.
Build and push the sandbox image with `bun run sandbox:build:k8s`.

```bash
TAU_SANDBOX_RUNTIME=k8s
TAU_K8S_NAMESPACE=tau-sandboxes
# TAU_K8S_RUNTIME_CLASS=sysbox-runc        # set empty to disable
# TAU_K8S_STORAGE_CLASS_RWX=...            # workspace/memory volumes
# TAU_K8S_STORAGE_CLASS_RWO=...            # nix store volumes
```

Local k3d instead:

```bash
bun run k3d:setup            # one-time: cluster, image, namespace, PVC
```

```bash
TAU_SANDBOX_RUNTIME=k8s
TAU_K8S_LOCAL=true
TAU_K8S_NAMESPACE=tau-sandboxes-dev
TAU_K8S_RUNTIME_CLASS=
```

Setup toolkit: `runtime.sandbox: k8s` (the toolkit does **not** build the
cluster).

Deep docs: [k8s/deployment.md](k8s/deployment.md) (cluster setup; Appendix A
is the full env-var reference) and
[k8s/local-dev-k3d.md](k8s/local-dev-k3d.md) (day-to-day k3d).

## Squad sandbox toolchains

Declare packages and an optional idempotent setup hook for every sandbox owned
by a squad:

```bash
tau squad toolchain set <squad-id> \
  --package python3@latest \
  --package terraform@latest \
  --setup-file ./scripts/tau-setup.sh
tau squad toolchain apply <squad-id>
tau squad toolchain get <squad-id>
```

Tau stores the setup file as durable inline code and runs it as the sandbox user
after installing the declared packages. Do not embed secrets in the script; read
them from the sandbox's existing environment instead. The script must be safe to
rerun after failures or configuration drift.

This managed toolchain is separate from repository `devbox.json`, legacy
`.tau/setup.sh`, custom images, and ad hoc `devbox add` workflows. Those existing
mechanisms remain unchanged. It is not available on the `host` runtime (see the
comparison table above).

## Switching runtimes on an existing install

That is the **instance-wide** switch. For changing a single squad without
restarting the instance into a different runtime, see
[Mixing runtimes](#mixing-runtimes-design--not-yet-shipped) (design status).

Change `TAU_SANDBOX_RUNTIME` (or `runtime.sandbox` in the toolkit config) and
restart the api and worker. Existing sandboxes on the old runtime are not
migrated: agents get a fresh sandbox on the new runtime, and the old
containers/pods/boxes are left for you to clean up. Squad workspaces and memory
live in tau's storage, not in the sandbox, so work is not lost — but a machine
change means a different filesystem, so uncommitted work inside an old sandbox
does not follow. See [machines/upgrading.md](machines/upgrading.md) for the
per-runtime migration notes.

Upgrading an existing install is the same story from the other side: the
upgrade rewrites no `.env`, so an install still carrying an old spelling (or no
value at all) must be edited **before** the api and worker are restarted — they
refuse to start otherwise, and both the setup toolkit's `upgrade-host.sh` and
the in-app updater stop before restarting rather than leave the instance down.
The in-app preflight ships WITH this change, so an instance still running
pre-rename code must set `TAU_SANDBOX_RUNTIME` in `.env` BEFORE applying the
update that introduces it; `upgrade-host.sh` from this checkout is safe either
way.
On the docker runtimes, expect every existing `tau-sandbox-*` container to be
recreated once after the upgrade: the runtime name is part of the container
spec hash, so the rename alone counts as drift. That recreate is safe —
workspaces, memory and private dirs are host bind mounts.

**Old spellings no longer start the core.** They were removed, not aliased:

| Old value | Now                                                  |
| --------- | ---------------------------------------------------- |
| `sysbox`  | `docker-sysbox`                                      |
| `socket`  | `docker-socket`                                      |
| `auto`    | choose `docker-sysbox` or `docker-socket` explicitly |
| `docker`  | choose `docker-sysbox` or `docker-socket` explicitly |

## Consultant conversations

A squad's consultant chats share one light runtime (`consultants_<squad-id>`).
Active squads warm this runtime alongside their squad workspace, so opening
another consultant chat normally reuses an already prepared environment. The
runtime can idle when squad activity expires; an always-on squad keeps it warm.

Each conversation retains its own history and short-term memory. Its shell starts
in `<private-root>/conversations/<agent-id>`, and each command receives the calling
agent's Tau token. Scratch directories prevent accidental filename collisions;
they are not security boundaries between consultants in the same squad. The
runtime, installed tools, browser state, and shell configuration are shared, so
coordinate changes and use squad resource slots where appropriate. Federation
signing requires dedicated key custody and is unavailable to shared consultants.

Terminating or deleting an individual conversation does not stop the shared
runtime. Archiving the squad removes it. Existing consultant chats immediately
use the shared runtime; old per-agent files are not migrated, and old personal
sandboxes remain eligible for normal idle/agent cleanup.
