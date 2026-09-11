#!/usr/bin/env bash
set -euo pipefail

LOCK_DIR=$(git rev-parse --path-format=absolute --git-path manager-first-human-grace-anchor-mutation.lock)
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "manager-first human grace mutation check is already running in this worktree" >&2
  exit 3
fi
RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/manager-first-human-grace-anchor-mutation.XXXXXX")
cleanup_run() {
  rm -rf "$RUN_DIR"
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup_run EXIT INT TERM
printf '%s\n' "$$" >"$LOCK_DIR/pid"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "mutation check requires a clean worktree" >&2
  exit 2
fi

SOURCE=apps/core/src/services/fleet-alerts/store.ts
TEST_FILE=apps/core/src/services/fleet-alerts/dead-fleet.test.ts
TEST_NAME='anchors a late manager-first human fallback to first alert materialization without deadline drift'

bun test "$TEST_FILE" -t "$TEST_NAME" >"$RUN_DIR/baseline.log" 2>&1 || {
  echo "baseline failed before mutation: $TEST_NAME" >&2
  cat "$RUN_DIR/baseline.log" >&2
  exit 1
}

(
  set -euo pipefail
  backup=$(mktemp "$RUN_DIR/source.XXXXXX")
  cp "$SOURCE" "$backup"
  restore() { cp "$backup" "$SOURCE"; rm -f "$backup"; }
  trap restore EXIT

  SOURCE="$SOURCE" python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ['SOURCE'])
source = path.read_text()
fixed = 'new Date(input.now.getTime() + input.humanDelayMs)'
historical = 'new Date(input.managerDueAt.getTime() + input.humanDelayMs)'
if source.count(fixed) != 1:
    raise SystemExit(f'expected exactly one mutation target, found {source.count(fixed)}')
path.write_text(source.replace(fixed, historical))
PY

  set +e
  bun test "$TEST_FILE" -t "$TEST_NAME" >"$RUN_DIR/mutation.log" 2>&1
  status=$?
  set -e
  if [[ $status -eq 0 ]]; then
    echo "mutation survived: $TEST_NAME" >&2
    cat "$RUN_DIR/mutation.log" >&2
    exit 1
  fi
  if ! grep -F '(fail)' "$RUN_DIR/mutation.log" | grep -F "$TEST_NAME" >/dev/null; then
    echo "mutant failed for the wrong reason: $TEST_NAME" >&2
    cat "$RUN_DIR/mutation.log" >&2
    exit 1
  fi
)

git diff --exit-code -- "$SOURCE" >/dev/null || {
  echo "mutation restoration failed: $SOURCE" >&2
  exit 1
}
git diff --exit-code >/dev/null
echo "historical manager-first human grace anchor mutant killed at intended assertion"
