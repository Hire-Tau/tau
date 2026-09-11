#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
[[ -z "$(git status --porcelain)" ]] || { echo 'mutation check requires a clean worktree' >&2; exit 2; }

manager=apps/core/src/services/ws/manager.ts
test_file=apps/core/src/services/ws/manager.test.ts
run_dir=$(mktemp -d)
backup="$run_dir/manager.ts"
cp "$manager" "$backup"

cleanup() {
  cp "$backup" "$manager"
  rm -rf "$run_dir"
}
trap cleanup EXIT

kill_mutant() {
  local label=$1 old=$2 new=$3 test_name=$4
  local baseline_log="$run_dir/baseline-$RANDOM.log"
  local mutant_log="$run_dir/mutant-$RANDOM.log"

  cp "$backup" "$manager"
  if ! env -u DATABASE_URL bun test "$test_file" -t "$test_name" >"$baseline_log" 2>&1; then
    echo "BASELINE FAILED: $label" >&2
    cat "$baseline_log" >&2
    exit 1
  fi

  OLD="$old" NEW="$new" FILE="$manager" python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ['FILE'])
source = path.read_text()
old = os.environ['OLD']
if source.count(old) != 1:
    raise SystemExit(f"mutation target count: {source.count(old)}")
path.write_text(source.replace(old, os.environ['NEW']))
PY

  set +e
  env -u DATABASE_URL bun test "$test_file" -t "$test_name" >"$mutant_log" 2>&1
  local status=$?
  set -e
  cp "$backup" "$manager"

  if [[ $status -eq 0 ]]; then
    echo "SURVIVED: $label" >&2
    cat "$mutant_log" >&2
    exit 1
  fi
  grep -F '(fail)' "$mutant_log" | grep -F "$test_name" >/dev/null || {
    echo "WRONG FAILURE: $label" >&2
    cat "$mutant_log" >&2
    exit 1
  }
  grep -F 'Expected number of calls: 0' "$mutant_log" >/dev/null || {
    echo "WRONG ASSERTION: $label" >&2
    cat "$mutant_log" >&2
    exit 1
  }
  echo "KILLED: $label"
}

kill_mutant \
  'remove post-await websocket registration fence' \
  'if (!authorized || !this.isActiveSubscriber(client, topic)) return' \
  'if (!authorized) return' \
  'does not send an in-flight broadcast after its registration is removed during authorization'
kill_mutant \
  'remove post-await websocket ready-state fence' \
  '(client.ws.readyState === undefined || client.ws.readyState === WebSocket.OPEN)' \
  'true' \
  'does not send when the socket closes during authorization'
kill_mutant \
  'remove post-await websocket subscription fence' \
  'client.subscriptions.has(topic) &&' \
  'true &&' \
  'does not send after the client unsubscribes during authorization'

trap - EXIT
rm -rf "$run_dir"
git diff --exit-code >/dev/null
echo 'websocket broadcast close fence mutants killed'
