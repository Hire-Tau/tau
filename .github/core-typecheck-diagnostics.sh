#!/usr/bin/env bash
set -uo pipefail

DIAGNOSTIC_NODE_OPTIONS='--max-old-space-size=6144'

diagnostic_revisions() {
  # Compare the selected commit with its own parent when one exists.
  git rev-parse --verify "${GITHUB_SHA}^" 2>/dev/null || true
  printf '%s\n' "$GITHUB_SHA"
}

finish_measurement() {
  local revision="$1"
  local sha="$2"
  local command_status="$3"
  local log="$4"
  local status="$command_status"
  local diagnostics
  local missing=()

  if [[ ! "$command_status" =~ ^[0-9]+$ ]]; then
    missing+=(status)
    status=65
  fi
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]] || ! grep -Fqx "=== revision=$revision exact_sha=$sha ===" "$log"; then
    missing+=(exact_sha)
  fi
  grep -Eq '^Memory used:[[:space:]]+[0-9]+K$' "$log" || missing+=(memory_used)
  grep -Eq '^Check time:[[:space:]]+[0-9]+([.][0-9]+)?s$' "$log" || missing+=(check_time)
  grep -Eq '^Total time:[[:space:]]+[0-9]+([.][0-9]+)?s$' "$log" || missing+=(total_time)
  grep -Eq '^[[:space:]]*Maximum resident set size [(]kbytes[)]: [0-9]+$' "$log" || missing+=(max_rss)

  if (( ${#missing[@]} > 0 )); then
    local missing_csv
    missing_csv=$(IFS=,; echo "${missing[*]}")
    echo "measurement_validation=failed missing=$missing_csv" | tee -a "$log"
    if [[ "$status" == 0 ]]; then
      status=65
    fi
  else
    echo 'measurement_validation=passed' | tee -a "$log"
  fi
  echo "measurement_command_status=$command_status" | tee -a "$log"
  echo "measurement_exit_status=$status" | tee -a "$log"
  diagnostics=$(grep -E '^(Memory used|Check time|Total time):|^[[:space:]]*Maximum resident set size [(]kbytes[)]:' "$log" | paste -sd ';' - || true)
  if [[ -z "$diagnostics" ]]; then
    diagnostics='unavailable'
  fi
  printf '| `%s` | `%s` | %s | %s |\n' "$revision" "$sha" "$status" "$diagnostics" >> "$GITHUB_STEP_SUMMARY"
  return "$status"
}

measure_revision() {
  local revision="$1"
  local sha='unresolved'
  local log="$RUNNER_TEMP/core-typecheck-$revision.log"
  local status

  : > "$log"
  echo "=== revision=$revision ===" | tee -a "$log"
  if ! git checkout --force "$revision" 2>&1 | tee -a "$log"; then
    status=${PIPESTATUS[0]}
    finish_measurement "$revision" "$sha" "$status" "$log"
    return $?
  fi
  if ! git clean -ffdx 2>&1 | tee -a "$log"; then
    status=${PIPESTATUS[0]}
    finish_measurement "$revision" "$sha" "$status" "$log"
    return $?
  fi

  sha=$(git rev-parse HEAD)
  log="$RUNNER_TEMP/core-typecheck-$sha.log"
  echo "=== revision=$revision exact_sha=$sha ===" > "$log"
  grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo | tee -a "$log"
  local cgroup_context=false
  local file
  for file in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.current; do
    if [[ -r "$file" ]]; then
      echo "$file=$(cat "$file")" | tee -a "$log"
      cgroup_context=true
    fi
  done
  if [[ "$cgroup_context" == false ]]; then
    echo 'cgroup_memory_context=unavailable (memory.max/current not readable)' | tee -a "$log"
  fi
  NODE_OPTIONS="$DIAGNOSTIC_NODE_OPTIONS" node -e \
    "const v8 = require('node:v8'); console.log('v8_heap_size_limit=' + v8.getHeapStatistics().heap_size_limit)" \
    | tee -a "$log"

  bun install --frozen-lockfile 2>&1 | tee -a "$log"
  status=${PIPESTATUS[0]}
  if [[ "$status" -ne 0 ]]; then
    finish_measurement "$revision" "$sha" "$status" "$log"
    return $?
  fi

  (
    cd apps/core
    NODE_OPTIONS="$DIAGNOSTIC_NODE_OPTIONS" /usr/bin/time -v bunx tsc --noEmit --extendedDiagnostics
  ) 2>&1 | tee -a "$log"
  status=${PIPESTATUS[0]}
  finish_measurement "$revision" "$sha" "$status" "$log"
}

run_measurements() {
  local overall_status=0
  local revision

  for revision in "$@"; do
    if ! measure_revision "$revision"; then
      overall_status=1
    fi
  done
  return "$overall_status"
}

run_diagnostics() {
  local revisions=()
  local revision
  # macOS ships Bash 3.2 without mapfile. Never silently measure an empty list.
  while IFS= read -r revision; do
    revisions+=("$revision")
  done < <(diagnostic_revisions)
  if (( ${#revisions[@]} == 0 )); then
    echo 'No diagnostic revisions were collected' >&2
    return 65
  fi
  run_measurements "${revisions[@]}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  candidate="$GITHUB_SHA"
  echo "job_url=${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
  printf '| revision | exact SHA | exit status | TypeScript diagnostics |\n|---|---|---:|---|\n' >> "$GITHUB_STEP_SUMMARY"

  overall_status=0
  if ! run_diagnostics; then
    overall_status=1
  fi
  if ! git checkout --force "$candidate"; then
    overall_status=1
  fi
  exit "$overall_status"
fi
