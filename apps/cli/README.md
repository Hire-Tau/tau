# Tau CLI

Command-line interface for Tau.

## Install

Install the latest released Tau CLI:

```bash
curl -fsSL https://ficus.sh/cli/install.sh | bash
```

The installer writes the CLI to `~/.tau/bin/tau` and bundled CLI assets to `~/.tau/share`. To reinstall or upgrade later, run `tau install`.

Add Tau to your `PATH` if needed:

```bash
export PATH="$HOME/.tau/bin:$PATH"
```

Verify the install:

```bash
tau --help
```

## Local Development

From the repository root:

```bash
bun run build:cli
./apps/cli/dist/tau.js --help
```
