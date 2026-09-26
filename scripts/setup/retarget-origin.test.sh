#!/usr/bin/env bash
# retarget-origin.test.sh — CLI-surface test of the real retarget-origin.sh
# script, run as a subprocess (never sourced): argument validation and
# --dry-run planning, which both run before any host mutation and so need no
# root, no real caddy, and no real systemd. The reusable helpers the mutating
# steps are built from (cfg_set, envfile_set, tls_pair_matches,
# install_origin_cert, render_caddyfile, caddy_write_and_reload,
# restart_core_services) are unit-tested directly in lib.test.sh — matching
# how this toolkit already tests setup-host.sh/upgrade-host.sh: the shared
# lib.sh helpers get unit coverage, the orchestration scripts get --dry-run
# coverage, and nothing here spins up a real caddy/systemd to exercise the
# actual mutation phase (7/7).
#
# Run: bash scripts/setup/retarget-origin.test.sh
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
RETARGET="${SCRIPT_DIR}/retarget-origin.sh"

PASS=0 FAIL=0
expect_eq() { # DESCRIPTION ACTUAL EXPECTED
  if [[ $2 == "$3" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — expected %q, got %q\n' "$1" "$3" "$2" >&2
  fi
}
expect_match() { # DESCRIPTION ACTUAL REGEX
  if [[ $2 =~ $3 ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — %q does not match /%s/\n' "$1" "$2" "$3" >&2
  fi
}

if ! command -v yq >/dev/null 2>&1 || ! yq --version 2>/dev/null | grep -q mikefarah; then
  printf 'SKIP: mikefarah yq v4 not on PATH — retarget-origin.test.sh needs it to parse the config (brew install yq)\n' >&2
  printf '\n%d passed, %d failed\n' "${PASS}" "${FAIL}"
  exit 0
fi

SCRATCH=$(mktemp -d -t retarget-origin-test.XXXXXX)
cleanup() { rm -rf "${SCRATCH}"; }
trap cleanup EXIT

CORE_DEST="${SCRATCH}/core"
mkdir -p "${CORE_DEST}"

CONFIG="${SCRATCH}/tau-setup.yaml"
cat >"${CONFIG}" <<EOF
source:
  repo: git@example.com:acme/tau.git
  dest: ${CORE_DEST}
core:
  origin: https://acme.hiretau.ai
  port: 3000
  env: {}
ingress:
  caddy: true
  tls_cert_path: /etc/caddy/tls/origin.crt
  tls_key_path: /etc/caddy/tls/origin.key
dns:
  zone: hiretau.ai
EOF
printf 'APP_URL=https://acme.hiretau.ai\nTAU_WEB_ORIGIN=https://acme.hiretau.ai\nTAU_ENCRYPTION_KEY=deadbeef\n' >"${CORE_DEST}/.env"
CONFIG_BYTES_BEFORE=$(cat "${CONFIG}")
ENV_BYTES_BEFORE=$(cat "${CORE_DEST}/.env")

CERT="${SCRATCH}/origin.crt"
KEY="${SCRATCH}/origin.key"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=acme.ficus.sh' \
  -keyout "${KEY}" -out "${CERT}" >/dev/null 2>&1
OTHER_KEY="${SCRATCH}/other.key"
openssl genrsa -out "${OTHER_KEY}" 2048 >/dev/null 2>&1

# --- --dry-run ----------------------------------------------------------------
dry_run_out=$("${RETARGET}" --config "${CONFIG}" --origin https://acme.ficus.sh \
  --tls-cert "${CERT}" --tls-key "${KEY}" \
  --dns-zone ficus.sh --ingest-url https://ficus.sh --dry-run 2>&1)
dry_run_rc=0
"${RETARGET}" --config "${CONFIG}" --origin https://acme.ficus.sh \
  --tls-cert "${CERT}" --tls-key "${KEY}" \
  --dns-zone ficus.sh --ingest-url https://ficus.sh --dry-run >/dev/null 2>&1 || dry_run_rc=$?
expect_eq '--dry-run exits zero' "${dry_run_rc}" '0'
expect_match '--dry-run plans the new core.origin' "${dry_run_out}" 'core\.origin: https://acme\.ficus\.sh'
expect_match '--dry-run plans ingress.tls_cert_path' "${dry_run_out}" "ingress\\.tls_cert_path: ${CERT//\//\\/}"
expect_match '--dry-run plans ingress.tls_key_path' "${dry_run_out}" "ingress\\.tls_key_path: ${KEY//\//\\/}"
expect_match '--dry-run plans dns.zone' "${dry_run_out}" 'dns\.zone: ficus\.sh'
expect_match '--dry-run plans core.env.TAU_PLATFORM_INGEST_URL' "${dry_run_out}" 'TAU_PLATFORM_INGEST_URL: https://ficus\.sh'
expect_match '--dry-run plans the .env rewrite' "${dry_run_out}" 'APP_URL=https://acme\.ficus\.sh'
expect_match '--dry-run plans TAU_WEB_ORIGIN' "${dry_run_out}" 'TAU_WEB_ORIGIN=https://acme\.ficus\.sh'
expect_match '--dry-run names the derived Caddy host' "${dry_run_out}" 'caddy — host acme\.ficus\.sh'
expect_match '--dry-run never touches the live Caddyfile' "${dry_run_out}" 'write /etc/caddy/Caddyfile'
expect_eq '--dry-run does not modify the config file' "$(cat "${CONFIG}")" "${CONFIG_BYTES_BEFORE}"
expect_eq '--dry-run does not modify the .env file' "$(cat "${CORE_DEST}/.env")" "${ENV_BYTES_BEFORE}"

dry_run_out_2=$("${RETARGET}" --config "${CONFIG}" --origin https://acme.ficus.sh \
  --tls-cert "${CERT}" --tls-key "${KEY}" \
  --dns-zone ficus.sh --ingest-url https://ficus.sh --dry-run 2>&1)
expect_eq '--dry-run is idempotent: running it twice prints the same plan' "${dry_run_out_2}" "${dry_run_out}"

# --- validation failures: exit non-zero with a clear message ------------------
run_rc() { # ...ARGS
  local rc=0
  "${RETARGET}" "$@" >/dev/null 2>/dev/null || rc=$?
  printf '%s' "${rc}"
}
run_err() { # ...ARGS
  # Deliberate order (SC2069): duplicate the CURRENT stdout (the caller's
  # $(...) capture pipe) onto stderr first, THEN send stdout itself to
  # /dev/null — the standard "capture stderr only" idiom, not a typo.
  # shellcheck disable=SC2069
  "${RETARGET}" "$@" 2>&1 >/dev/null || true
}

expect_eq 'http origin: exits non-zero' \
  "$(run_rc --config "${CONFIG}" --origin http://acme.ficus.sh --tls-cert "${CERT}" --tls-key "${KEY}" --dry-run)" '1'
expect_match 'http origin: names the requirement' \
  "$(run_err --config "${CONFIG}" --origin http://acme.ficus.sh --tls-cert "${CERT}" --tls-key "${KEY}" --dry-run)" \
  'bare https origin'

expect_eq 'origin with a port: exits non-zero' \
  "$(run_rc --config "${CONFIG}" --origin https://acme.ficus.sh:8443 --tls-cert "${CERT}" --tls-key "${KEY}" --dry-run)" '1'
expect_match 'origin with a port: names the portless requirement' \
  "$(run_err --config "${CONFIG}" --origin https://acme.ficus.sh:8443 --tls-cert "${CERT}" --tls-key "${KEY}" --dry-run)" \
  'portless core\.origin'

expect_eq 'origin with a path: exits non-zero' \
  "$(run_rc --config "${CONFIG}" --origin https://acme.ficus.sh/x --tls-cert "${CERT}" --tls-key "${KEY}" --dry-run)" '1'

expect_eq 'key/cert mismatch: exits non-zero' \
  "$(run_rc --config "${CONFIG}" --origin https://acme.ficus.sh --tls-cert "${CERT}" --tls-key "${OTHER_KEY}" --dry-run)" '1'
expect_match 'key/cert mismatch: names the mismatch' \
  "$(run_err --config "${CONFIG}" --origin https://acme.ficus.sh --tls-cert "${CERT}" --tls-key "${OTHER_KEY}" --dry-run)" \
  'do not match'

expect_eq 'missing --tls-cert file: exits non-zero' \
  "$(run_rc --config "${CONFIG}" --origin https://acme.ficus.sh --tls-cert "${SCRATCH}/nope.crt" --tls-key "${KEY}" --dry-run)" '1'
expect_match 'missing --tls-cert file: names the path' \
  "$(run_err --config "${CONFIG}" --origin https://acme.ficus.sh --tls-cert "${SCRATCH}/nope.crt" --tls-key "${KEY}" --dry-run)" \
  'file not found'

expect_eq 'missing --tls-key file: exits non-zero' \
  "$(run_rc --config "${CONFIG}" --origin https://acme.ficus.sh --tls-cert "${CERT}" --tls-key "${SCRATCH}/nope.key" --dry-run)" '1'

expect_eq 'missing --config file: exits non-zero' \
  "$(run_rc --config "${SCRATCH}/nope.yaml" --origin https://acme.ficus.sh --tls-cert "${CERT}" --tls-key "${KEY}" --dry-run)" '1'
expect_match 'missing --config file: names the config path' \
  "$(run_err --config "${SCRATCH}/nope.yaml" --origin https://acme.ficus.sh --tls-cert "${CERT}" --tls-key "${KEY}" --dry-run)" \
  'not found'

expect_eq 'missing --dns-zone value is fine (optional flag)' \
  "$(run_rc --config "${CONFIG}" --origin https://acme.ficus.sh --tls-cert "${CERT}" --tls-key "${KEY}" --dry-run)" '0'

expect_eq 'bad --dns-zone (looks like a URL): exits non-zero' \
  "$(run_rc --config "${CONFIG}" --origin https://acme.ficus.sh --tls-cert "${CERT}" --tls-key "${KEY}" --dns-zone 'https://ficus.sh' --dry-run)" '1'

expect_eq 'bad --ingest-url (not https): exits non-zero' \
  "$(run_rc --config "${CONFIG}" --origin https://acme.ficus.sh --tls-cert "${CERT}" --tls-key "${KEY}" --ingest-url 'http://ficus.sh' --dry-run)" '1'

expect_eq 'missing --config flag entirely: exits non-zero' \
  "$(run_rc --origin https://acme.ficus.sh --tls-cert "${CERT}" --tls-key "${KEY}" --dry-run)" '1'
expect_eq 'missing --origin flag entirely: exits non-zero' \
  "$(run_rc --config "${CONFIG}" --tls-cert "${CERT}" --tls-key "${KEY}" --dry-run)" '1'
expect_eq 'missing --tls-cert flag entirely: exits non-zero' \
  "$(run_rc --config "${CONFIG}" --origin https://acme.ficus.sh --tls-key "${KEY}" --dry-run)" '1'
expect_eq 'missing --tls-key flag entirely: exits non-zero' \
  "$(run_rc --config "${CONFIG}" --origin https://acme.ficus.sh --tls-cert "${CERT}" --dry-run)" '1'

expect_eq '--help exits zero' "$(run_rc --help)" '0'
expect_eq 'an unknown flag exits non-zero' "$(run_rc --config "${CONFIG}" --wat)" '1'

printf '\n%d passed, %d failed\n' "${PASS}" "${FAIL}"
[[ ${FAIL} -eq 0 ]]
