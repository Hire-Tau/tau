#!/usr/bin/env bash
set -euo pipefail

LOCK_DIR=$(git rev-parse --path-format=absolute --git-path sandbox-recovery-mutation.lock)
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "sandbox recovery mutation check is already running in this worktree" >&2
  exit 3
fi
RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/sandbox-recovery-mutation.XXXXXX")
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

mutate_and_require_failure() {
  local file=$1 old=$2 new=$3 test_file=$4 test_name=$5

  # A broken baseline is never evidence that a mutant was killed.
  bun test "$test_file" -t "$test_name" >"$RUN_DIR/baseline.log" 2>&1 || {
    echo "baseline failed before mutation: $test_name" >&2
    cat "$RUN_DIR/baseline.log" >&2
    exit 1
  }

  (
    set -euo pipefail
    local backup
    backup=$(mktemp "$RUN_DIR/source.XXXXXX")
    cp "$file" "$backup"
    restore() { cp "$backup" "$file"; rm -f "$backup"; }
    trap restore EXIT

    OLD="$old" NEW="$new" FILE="$file" python3 - <<'PY'
import os
from pathlib import Path
p = Path(os.environ['FILE'])
s = p.read_text()
old, new = os.environ['OLD'], os.environ['NEW']
if s.count(old) != 1:
    raise SystemExit(f"expected exactly one mutation target, found {s.count(old)}")
p.write_text(s.replace(old, new))
PY

    set +e
    bun test "$test_file" -t "$test_name" >"$RUN_DIR/mutation.log" 2>&1
    local status=$?
    set -e
    if [[ $status -eq 0 ]]; then
      echo "mutation survived: $test_name" >&2
      cat "$RUN_DIR/mutation.log" >&2
      exit 1
    fi
    if ! grep -F '(fail)' "$RUN_DIR/mutation.log" | grep -F "$test_name" >/dev/null; then
      echo "mutant failed for the wrong reason: $test_name" >&2
      cat "$RUN_DIR/mutation.log" >&2
      exit 1
    fi
  )

  git diff --exit-code -- "$file" >/dev/null || {
    echo "mutation restoration failed: $file" >&2
    exit 1
  }
  echo "killed at intended assertion: $test_name"
}

TRANSITION_TEST=apps/core/src/entities/Execution.transitionTo.test.ts
STORE_TEST=apps/core/src/services/sandbox/k8s/provision-recovery-store.test.ts
RECOVERY_TEST=apps/core/src/services/sandbox/k8s/provision-recovery.test.ts

# Persistence/idempotency token.
mutate_and_require_failure apps/core/src/entities/Execution.ts \
  "eq(sandboxProvisionRecoveries.refusalId, outcome.recovery.refusalId)" \
  "eq(sandboxProvisionRecoveries.refusalId, '00000000-0000-0000-0000-000000000000')" \
  "$TRANSITION_TEST" "releases the provider slot without emitting duplicate events"

# Generation and lease-owner fences.
GEN_OWNER_BLOCK=$(cat <<'EOF'
eq(sandboxProvisionRecoveries.generation, outcome.generation),
                  eq(sandboxProvisionRecoveries.leaseOwner, outcome.leaseOwner),
                  eq(sandboxProvisionRecoveries.status, 'leased'),
                  eq(sandboxProvisionRecoveries.claimKind, outcome.claimKind)
EOF
)
mutate_and_require_failure apps/core/src/entities/Execution.ts "$GEN_OWNER_BLOCK" \
  "${GEN_OWNER_BLOCK/eq(sandboxProvisionRecoveries.generation, outcome.generation)/sql\`TRUE\`}" \
  "$TRANSITION_TEST" "rejects stale recovery generation and lease owner fences"
mutate_and_require_failure apps/core/src/entities/Execution.ts "$GEN_OWNER_BLOCK" \
  "${GEN_OWNER_BLOCK/eq(sandboxProvisionRecoveries.leaseOwner, outcome.leaseOwner)/sql\`TRUE\`}" \
  "$TRANSITION_TEST" "rejects stale recovery generation and lease owner fences"

# Resume execution-status CAS and persisted claim kind.
RESUME_CAS_BLOCK=$(cat <<'EOF'
.set({ status: 'queued' })
              .where(and(eq(executions.id, this.id), eq(executions.status, 'waiting-sandbox')))
EOF
)
RESUME_CAS_MUTANT=$(cat <<'EOF'
.set({ status: 'queued' })
              .where(and(eq(executions.id, this.id), eq(executions.status, 'queued')))
EOF
)
mutate_and_require_failure apps/core/src/entities/Execution.ts "$RESUME_CAS_BLOCK" "$RESUME_CAS_MUTANT" \
  "$TRANSITION_TEST" "atomically suspends and resumes the same execution"
mutate_and_require_failure apps/core/src/entities/Execution.ts \
  "eq(sandboxProvisionRecoveries.claimKind, outcome.claimKind)" \
  "eq(sandboxProvisionRecoveries.claimKind, outcome.claimKind === 'ordinary' ? 'half_open_probe' : 'ordinary')" \
  "$TRANSITION_TEST" "rejects a mismatched persisted claim kind"

# Concurrent ownership, fixed batch, per-sandbox fairness, and half-open gate.
mutate_and_require_failure apps/core/src/services/sandbox/k8s/provision-recovery-store.ts \
  "FOR UPDATE OF r SKIP LOCKED" "FOR UPDATE OF r" \
  "$STORE_TEST" "SKIP LOCKED does not wait behind another recovery owner"
mutate_and_require_failure apps/core/src/services/sandbox/k8s/provision-recovery-store.ts \
  'LIMIT ${PROVISION_RECOVERY_BATCH_SIZE}' 'LIMIT 80' \
  "$STORE_TEST" "leases 100 waiters"
mutate_and_require_failure apps/core/src/services/sandbox/k8s/provision-recovery-store.ts \
  "AND live_sandbox.status = 'leased'" "AND live_sandbox.status = 'resumed'" \
  "$STORE_TEST" "leases a fixed fair batch"
mutate_and_require_failure apps/core/src/services/sandbox/k8s/provision-recovery-store.ts \
  "PARTITION BY eligible.scope, eligible.sandbox_key" "PARTITION BY eligible.scope" \
  "$STORE_TEST" "leases a fixed fair batch"
HALF_OPEN_GATE=$(cat <<'EOF'
AND c.state <> 'half_open'
            AND (
              c.state = 'closed'
EOF
)
HALF_OPEN_MUTANT=$(cat <<'EOF'
AND TRUE
            AND (
              c.state IN ('closed', 'half_open')
EOF
)
mutate_and_require_failure apps/core/src/services/sandbox/k8s/provision-recovery-store.ts \
  "$HALF_OPEN_GATE" "$HALF_OPEN_MUTANT" \
  "$STORE_TEST" "leases one open-scope probe, none during half-open"

# Deadline and attempt caps plus permanent-error exclusion.
mutate_and_require_failure apps/core/src/services/sandbox/k8s/provision-recovery.ts \
  "lease.deadlineAt <= now || lease.attemptCount >= PROVISION_RECOVERY_MAX_ATTEMPTS" \
  "false || lease.attemptCount >= PROVISION_RECOVERY_MAX_ATTEMPTS" \
  "$RECOVERY_TEST" "exhausts a wait after its durable deadline"
mutate_and_require_failure apps/core/src/services/sandbox/k8s/provision-recovery.ts \
  "lease.deadlineAt <= now || lease.attemptCount >= PROVISION_RECOVERY_MAX_ATTEMPTS" \
  "lease.deadlineAt <= now || false" \
  "$RECOVERY_TEST" "exhausts a wait at the durable attempt cap"
mutate_and_require_failure apps/core/src/services/sandbox/k8s/provision-recovery.ts \
  "PERMANENT_CONTROL_REASONS.has(control.reasonCode)" "false" \
  "$RECOVERY_TEST" "permanent authorization failure"

# Terminal-transition cancellation and active-status inclusion.
mutate_and_require_failure apps/core/src/entities/Execution.ts \
  "inArray(sandboxProvisionRecoveries.status, ['waiting', 'leased'])" \
  "inArray(sandboxProvisionRecoveries.status, ['resumed'])" \
  "$TRANSITION_TEST" "cancels a live recovery row on a terminal transition"
mutate_and_require_failure apps/core/src/services/execution/status.ts \
  "  'waiting-sandbox'," '' \
  apps/core/src/entities/Execution.test.ts "preserves the one-active-execution invariant"

git diff --exit-code >/dev/null
echo "all sandbox recovery mutations were killed at their intended assertions"
