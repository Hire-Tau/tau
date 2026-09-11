# Agent Configuration

This directory contains configuration files used by pi-agent sessions:

- **`skills/`** — Custom skill definitions (SKILL.md files) loaded into agent system prompts
- **`extensions/`** — Pi extensions loaded at session creation time

## How agents access these files

Skills and extensions are referenced by **absolute path** in the agent's system
prompt (e.g., `<location>/app/config/skills/brainstorming/SKILL.md</location>`).
When an agent uses the `read` tool to load a skill file, the path must resolve
to an actual file.

### Docker sandbox

In Docker mode, this directory is bind-mounted into the sandbox container at its
original host path, so skill file references resolve correctly.

### Kubernetes sandbox

In K8s mode, sandbox pods don't have access to Core's filesystem. Instead, the
K8s read tool **intercepts** any read request under `config/agent/` and serves
the file directly from the Core process rather than forwarding it to the sandbox
pod via HTTP. This means:

- Skills and extensions work without mounting this directory into sandbox pods
- Only files under `config/agent/` are intercepted — workspace files still go
  through HTTP to the sandbox pod as normal
- The interception is transparent to the agent

## Adding skills

Create a subdirectory with a `SKILL.md` file:

```
config/skills/my-skill/SKILL.md
```

Then reference it in an agent type YAML:

```yaml
skills:
  - my-skill
```
