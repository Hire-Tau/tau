#!/usr/bin/env bash
# Auto-deploy on push to main.

set -euo pipefail

OUTPUT=$(git pull 2>&1)
echo "$OUTPUT"
if echo "$OUTPUT" | grep -q "Already up to date"; then
  echo "No changes, skipping auto-deploy"
  exit 0
fi
bun install && bun run build && bun reload
