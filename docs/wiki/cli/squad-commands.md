# Squad CLI Commands

The `tau squad` command manages squads: teams of agents that work together on work streams. This page covers common commands; run `tau squad --help` for additional workspace, memory, subscription, and administration commands.

## Overview

```bash
tau squad [command] [options]
```

## Commands

### list

List all squads.

```bash
tau squad list [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `-s, --status <status>` | Filter by status (`active`, `paused`, `archived`) |
| `-a, --include-anonymous` | Include anonymous squads in the listing |

**Examples:**

```bash
# List visible squads (soft-deleted squads are excluded)
tau squad list

# List only paused squads
tau squad list --status paused

# Include anonymous squads
tau squad list --include-anonymous
```

---

### create

Create a new squad.

```bash
tau squad create|new [options] <name>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `name` | Name of the new squad |

**Options:**
| Option | Description |
|--------|-------------|
| `-p, --purpose <purpose>` | Squad purpose/mission statement |
| `-t, --type <typeId>` | Squad preset ID (e.g., `general`, `research`, `engineering`) |
| `-a, --default-agent <agentType>` | Default agent type to include (can be repeated) |

**Examples:**

```bash
# Create a basic squad
tau squad create "Frontend Team"

# Create an engineering squad with purpose
tau squad create "API Development" --preset engineering --purpose "Build and maintain REST APIs"

# Legacy manual default staffing; workflow participants are normally created lazily
tau squad create "Full Stack Team" -a architect -a engineer -a reviewer
```

---

### get

Get detailed information about a squad.

```bash
tau squad get|info <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Squad ID |

**Examples:**

```bash
# Get squad details
tau squad get abc123

# Using alias
tau squad info abc123
```

---

### update

Update an existing squad.

```bash
tau squad update|edit [options] <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Squad ID to update |

**Options:**
| Option | Description |
|--------|-------------|
| `-n, --name <name>` | New name for the squad |
| `-p, --purpose <purpose>` | New purpose statement |
| `-s, --status <status>` | New status (`active`, `paused`, `archived`) |
| `--add-default-agent <agentType>` | Add a default agent type |
| `--remove-default-agent <agentType>` | Remove a default agent type |

**Examples:**

```bash
# Rename a squad
tau squad update abc123 --name "New Team Name"

# Pause a squad
tau squad update abc123 --status paused

# Add a reviewer agent to the squad
tau squad update abc123 --add-default-agent reviewer

# Multiple updates at once
tau squad update abc123 --name "Updated Team" --purpose "New mission"
```

---

### delete

Archive a squad (soft delete), preserving its agents, work streams, messages, and history. Archive hides it from normal listings, revokes its agent tokens, disables squad schedules, clears default channel routing to it, retires slot coordination, and removes its shared sandbox. It deletes indexed memory chunks while preserving memory documents and links. Archived squads reject guarded mutations with `410 Squad is archived`.

Workspace and SSH files are retained by default. `--delete-workspace` also permanently removes the managed storage workspace and squad SSH directory; a host workspace override is never deleted.

```bash
tau squad delete|rm|archive [--delete-workspace] <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Squad ID to archive |

**Examples:**

```bash
# Archive a squad and keep workspace files
tau squad delete abc123

# Using an alias
tau squad archive abc123

# Archive and permanently remove managed workspace and SSH files
tau squad delete abc123 --delete-workspace
```

---

### workspace

Show the workspace directory tree for a squad.

```bash
tau squad workspace|ws <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Squad ID |

**Examples:**

```bash
# View squad workspace structure
tau squad workspace abc123

# Using alias
tau squad ws abc123
```

---

### file

Show file contents from a squad's workspace.

```bash
tau squad file|cat <id> <path>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Squad ID |
| `path` | Path to the file within the workspace |

**Examples:**

```bash
# View a file from squad workspace
tau squad file abc123 src/index.js

# Using alias
tau squad cat abc123 README.md
```

---

### link

Create a relationship between two squads.

```bash
tau squad link [options] <source> <target>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `source` | Source squad ID |
| `target` | Target squad ID |

**Options:**
| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Relationship type: `reports_to`, `collaborates`, `depends_on` |

**Examples:**

```bash
# Create a reporting relationship
tau squad link team-a team-b --type reports_to

# Create a collaboration relationship
tau squad link frontend backend --type collaborates

# Create a dependency relationship
tau squad link api database --type depends_on
```

---

### unlink

Remove a relationship between squads.

```bash
tau squad unlink <relationshipId>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `relationshipId` | ID of the relationship to remove |

**Examples:**

```bash
# Remove a relationship
tau squad unlink rel-123
```

---

### relationships

List all relationships for a squad.

```bash
tau squad relationships|rels <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Squad ID |

**Examples:**

```bash
# List squad relationships
tau squad relationships abc123

# Using alias
tau squad rels abc123
```

---

### can-communicate

Check if two squads can communicate with each other.

```bash
tau squad can-communicate|can-comm <squadA> <squadB>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `squadA` | First squad ID |
| `squadB` | Second squad ID |

**Examples:**

```bash
# Check communication capability
tau squad can-communicate team-a team-b

# Using alias
tau squad can-comm frontend backend
```

---

### agents

List all agents in a squad.

```bash
tau squad agents <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Squad ID |

**Examples:**

```bash
# List squad agents
tau squad agents abc123
```

---

### Listing squad work streams

Use the work-stream command group:

```bash
tau workstream list --squad abc123
```

`tau squad tasks` is not a command. `--squad <squadId>` filters the work-stream list by squad.

---

### spawn

Spawn a new agent in a squad.

```bash
tau squad spawn [options] <agentType> <squadId>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `agentType` | Type of agent to spawn (e.g., `engineer`, `architect`, `reviewer`) |
| `squadId` | Squad ID to spawn the agent in |

**Options:**
| Option | Description |
|--------|-------------|
| `-w, --workstream <workstreamId>` | Assign the spawned agent to a work stream |

**Examples:**

```bash
# Spawn an engineer in a squad
tau squad spawn engineer abc123

# Spawn and assign to a work stream
tau squad spawn architect abc123 --workstream ws-456
```

---

### unspawn

Terminate a flex agent.

```bash
tau squad unspawn <agentId>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `agentId` | Agent ID to terminate |

**Examples:**

```bash
# Terminate a flex agent
tau squad unspawn agent-789
```

---

## Attention (watch)

Watching a squad sets two independent attention levels for it: `decisions` (questions, reviews, blockers) and `progress` (active work and completions). Each is `mute` (hidden from your Action Center and feed), `show` (listed, never interrupts), or `notify` (listed, plus an inbox message and push).

```bash
tau squad subscription SQUAD_ID          # your levels + watcher count
tau squad watch SQUAD_ID                 # both kinds at notify (alias of subscribe)
tau squad watch SQUAD_ID --progress mute # keep decisions as-is, stop completion notices
tau squad watch SQUAD_ID --decisions mute --progress mute
tau squad unwatch SQUAD_ID               # remove the row; back to show/show
```

An omitted flag keeps the kind at its current EFFECTIVE level — the level stored on your row if you have one, otherwise the default `show`. Changing one kind never turns the other one up. A per-work-stream row overrides these levels for that one stream.

## Workflow configuration

Configure the default source in squad `metadata.workflow`. Store selection guidance and alternatives in `metadata.workflowSetup`. The `setup-workflows` manager skill helps choose these without creating agents. A squad preset describes its domain; worker combinations and orchestration belong to workflows. See [the workflow guide](../workflows.md).

## Squad Presets

Use `tau squad-preset` to view available squad presets:

```bash
# List all squad presets
tau squad-preset list

# Get details about a specific type
tau squad-preset get engineering
```

Available squad presets:

- `engineering` — Software development, starting with Solo Coding and a selection of engineering workflows.
- `engineering` - Software development team for building and maintaining code

## Common Workflows

### Creating a Development Team

```bash
# Create an engineering squad
tau squad create "Backend API Team" \
  --preset engineering \
  --purpose "Develop and maintain the REST API"

# Link it to the platform team
tau squad link backend-team platform-team --type collaborates
```

### Managing metadata

```bash
tau squad set-meta <id> ledger.current.sequence 7
tau squad get-meta <id> ledger.current.sequence
tau squad unset-meta <id> ledger.current.sequence
```

`set-meta` and `unset-meta` send only the requested dot-path delta. The server recursively merges objects, deletes keys set to `null`, and serializes concurrent updates so unrelated keys are preserved. Arrays replace the whole array; changing one element requires `get-meta`, local modification, and `set-meta` of the entire array key. Concurrent writers to the same key are last-serialized-writer-wins. Empty path segments and `__proto__`, `prototype`, or `constructor` segments are rejected. `get-meta` uses one entity GET, extracts the value client-side, and reports missing paths as errors.

### Managing Squad Lifecycle

```bash
# Pause a squad (e.g., during reorganization)
tau squad update abc123 --status paused

# Archive a completed squad with the full archive lifecycle
tau squad archive abc123

# Reactivate a paused squad
tau squad update abc123 --status active
```

Use `archive` (or `delete`) for the full archive lifecycle. The legacy `update --status archived` option remains accepted but only changes status; it does not perform the soft-delete cleanup above. `--status active` reactivates a paused squad, not a soft-deleted squad.

### Scaling a Squad

```bash
# Spawn additional engineers for a sprint
tau squad spawn engineer abc123 --workstream ws-sprint-1
tau squad spawn engineer abc123 --workstream ws-sprint-2

# Clean up after sprint
tau squad unspawn agent-1
tau squad unspawn agent-2
```
