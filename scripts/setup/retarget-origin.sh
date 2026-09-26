#!/usr/bin/env bash
# retarget-origin.sh — ON-TARGET tau retarget primitive.
#
# Moves an ALREADY SET UP, RUNNING tau host to a new public origin (e.g. a
# tenant subdomain moving from hiretau.ai to ficus.sh) without re-running
# setup-host.sh. A full re-run cannot work on a hosted tenant: setup-host.sh
# needs secrets that are deleted from the box after provisioning, re-syncs
# source.ref (which would roll the box back to whatever the on-VM yaml still
# says), and reinstalls fleet artifacts that a later sync has since replaced.
# This script instead changes exactly what depends on the public origin.
# First, unconditionally, BEFORE any of the numbered steps below (in both
# --dry-run and real execution): validate the new origin, the pushed
# cert/key pair, the config, and that this host actually has a caddy
# ingress to retarget. Then, for a real (non-dry-run) run only:
#
#   1. back up the on-VM yaml and Core .env
#   2. rewrite core.origin, ingress.tls_{cert,key}_path, and (optionally)
#      dns.zone / core.env.TAU_PLATFORM_INGEST_URL in the yaml
#   3. back up, then install, the pushed cert pair to the canonical Caddy
#      TLS paths
#   4. rewrite APP_URL / TAU_WEB_ORIGIN (and TAU_PLATFORM_INGEST_URL, if
#      given) in <dest>/.env, preserving every other line
#   5. re-render + reload the Caddyfile for the new host
#   6. restart tau-api/tau-worker and wait for the API to come back healthy
#
# Out of scope, by design: DNS records (a Platform job does those via the
# Cloudflare API), fleet artifacts (sync-artifacts), secrets, source/
# artifacts.dir, and WebAuthn data (existing passkeys are origin-bound and
# invalidate on any origin change — that is unconditional, not a bug here).
#
# Idempotent: every step below is safe to re-run, including after a partial
# failure — rewriting the same yaml/.env keys to the same values, installing
# the same cert bytes, and re-rendering the same Caddyfile are all no-ops on
# a second run.
#
# FAILURE BEHAVIOR: steps 1-4 (backups, yaml rewrite, cert install) either
# fully apply or die() before touching anything past that point. If step 5
# (caddy re-render/reload) fails, the PREVIOUS origin certificate is
# restored to the canonical Caddy TLS paths before this script dies — so a
# failed run leaves the host serving ITS OWN (old) cert against whatever
# Caddyfile caddy_write_and_reload's own internal rollback left live,
# instead of the new cert with no matching live config. The yaml/.env
# rewrites from steps 2 and 4 are NOT rolled back on a step-5 failure (they
# are already-correct forward progress for a retry); the timestamped backups
# from step 1 are there if an operator needs to revert them by hand. Step 6
# (restart + health wait) failing after a successful caddy reload means the
# new origin/cert/Caddyfile are live but tau-api/tau-worker are not
# confirmed healthy — rerun this script (idempotent) or investigate the
# units directly; nothing here rolls the cert back at that point since the
# new Caddyfile is already the one Caddy is serving.
#
# Run as root on the tenant VM (EUID 0 — sudo is not supported: see the
# EUID check below), from the directory holding the copied toolkit (next to
# lib.sh).
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

usage() {
  cat <<'EOF'
Usage: retarget-origin.sh --config tau-setup.yaml --origin https://<sub>.<domain> \
                           --tls-cert PATH --tls-key PATH \
                           [--dns-zone DOMAIN] [--ingest-url https://URL] [--dry-run]

Moves an already-running tau host to a new public origin. See the header
comment in this file for the full behavior.

Options:
  --config FILE     the on-VM config this host was set up with (see
                     tau-setup.example.yaml) — rewritten in place
  --origin URL      the new browser-facing origin: scheme://host, https,
                     no port, no path
  --tls-cert PATH   the new origin certificate (already pushed to this VM)
  --tls-key PATH    the new origin certificate's private key
  --dns-zone DOMAIN optional: rewrite dns.zone to this value
  --ingest-url URL  optional: rewrite core.env.TAU_PLATFORM_INGEST_URL (and
                     the running .env's TAU_PLATFORM_INGEST_URL) to this value
  --dry-run         print the planned yaml keys, .env keys, Caddy host and
                     units without changing anything
  -h, --help        show this help
EOF
}

CONFIG='' ORIGIN='' TLS_CERT='' TLS_KEY='' DNS_ZONE='' INGEST_URL='' DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      CONFIG=${2:?--config needs a value}
      shift 2
      ;;
    --origin)
      ORIGIN=${2:?--origin needs a value}
      shift 2
      ;;
    --tls-cert)
      TLS_CERT=${2:?--tls-cert needs a value}
      shift 2
      ;;
    --tls-key)
      TLS_KEY=${2:?--tls-key needs a value}
      shift 2
      ;;
    --dns-zone)
      DNS_ZONE=${2:?--dns-zone needs a value}
      shift 2
      ;;
    --ingest-url)
      INGEST_URL=${2:?--ingest-url needs a value}
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ -n ${CONFIG} ]] || {
  usage >&2
  die "--config is required"
}
[[ -n ${ORIGIN} ]] || {
  usage >&2
  die "--origin is required"
}
[[ -n ${TLS_CERT} ]] || {
  usage >&2
  die "--tls-cert is required"
}
[[ -n ${TLS_KEY} ]] || {
  usage >&2
  die "--tls-key is required"
}

# ============================================================== 1. validate
#
# Everything here runs BEFORE any host mutation, in both dry-run and real
# execution, and every failure is a die() (exit 1) with a message naming
# exactly what is wrong.

[[ -f ${CONFIG} ]] || die "config file '${CONFIG}' not found — this host does not look like it was set up by this toolkit"

# A bare https://<hostname> and NOTHING else: no userinfo (user:pass@), no
# port, no path, no query string, no fragment. The old check here
# (^https://[^/[:space:]]+$) rejected a path but let anything else through
# a hostname's position — an origin like https://evil@acme.ficus.sh or
# https://acme.ficus.sh?x=1 would have passed it and then landed, verbatim,
# in core.origin/APP_URL/TAU_WEB_ORIGIN and the rendered Caddyfile.
CADDY_HOSTNAME_RE='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$'
[[ ${ORIGIN} =~ ^https://(${CADDY_HOSTNAME_RE#^})$ ]] ||
  die "--origin must be a bare https origin https://<hostname> — no userinfo, port, path, query, or fragment (got '${ORIGIN}')"
# caddy_host_from_origin additionally rejects an explicit port — Caddy owns
# 443 here and proxies to 127.0.0.1:<core.port>, so a port in the origin
# would leave the vhost listening on the wrong thing. (The hostname regex
# above already excludes ':', so this is now a defensive backstop that
# should never actually fire — kept because the contract calls for reusing
# it, and because it is the single source of truth for the derived host.)
CADDY_HOST=$(caddy_host_from_origin "${ORIGIN}")

preflight_tls_source '--tls-cert' "${TLS_CERT}"
preflight_tls_source '--tls-key' "${TLS_KEY}"
tls_pair_matches "${TLS_CERT}" "${TLS_KEY}" ||
  die "--tls-cert and --tls-key do not match (the certificate's public key does not correspond to the private key)"

if [[ -n ${DNS_ZONE} ]]; then
  [[ ${DNS_ZONE} =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] ||
    die "--dns-zone must be a bare domain, no scheme/path (got '${DNS_ZONE}')"
fi
if [[ -n ${INGEST_URL} ]]; then
  [[ ${INGEST_URL} =~ ^https://[^[:space:]]+$ ]] ||
    die "--ingest-url must be an https URL (got '${INGEST_URL}')"
fi

# Preflight (before ANY mutation, so it runs in --dry-run too): this script
# only RETARGETS an existing caddy ingress, it never installs caddy — a
# missing binary or service user means this host was never set up with
# ingress.caddy: true, and every later step (install_origin_cert,
# caddy_write_and_reload) would fail deep in, after some other mutation may
# already have landed.
require_cmd caddy "this host has no caddy ingress to retarget — see setup-host.sh's install_caddy/phase_caddy for initial setup"
id -u caddy >/dev/null 2>&1 ||
  die "the 'caddy' service user does not exist — this host does not look like it has caddy ingress configured (see setup-host.sh's phase_caddy)"

if [[ ${DRY_RUN} -eq 1 ]]; then
  yq_is_mikefarah || die "dry run needs mikefarah yq v4 on PATH to parse the config (brew install yq / see README)"
else
  ensure_yq
fi
cfg_load "${CONFIG}"

SRC_DEST=$(expand_tilde "$(cfg_get '.source.dest' '/opt/tau-core')")
ENV_FILE="${SRC_DEST}/.env"

[[ -f ${ENV_FILE} ]] || die "Core .env not found at '${ENV_FILE}' — is this host set up by this toolkit, and does core.source.dest in ${CONFIG} match the real install path?"

# The health check (step 6) has to probe the port core ACTUALLY listens on.
# That is PORT in the running .env, not core.port in the yaml — the two can
# drift (a core.env passthrough override, a manual .env edit, an operator
# reusing an old yaml against a box whose .env was hand-patched, ...), and
# the .env is what the systemd units' EnvironmentFile= line feeds the
# process. Fall back to the yaml only when .env has no PORT at all.
CORE_PORT=$(envfile_get "${ENV_FILE}" 'PORT') || CORE_PORT=''
[[ -n ${CORE_PORT} ]] || CORE_PORT=$(cfg_get '.core.port' '3000')
[[ ${CORE_PORT} =~ ^[0-9]+$ ]] || die "core port must be a number (got '${CORE_PORT}' from ${ENV_FILE} or config: core.port)"

# ============================================================== dry run

if [[ ${DRY_RUN} -eq 1 ]]; then
  log_step "DRY RUN — printing the plan; nothing will be executed or modified"
  printf '\nyaml — %s\n' "${CONFIG}"
  plan "core.origin: ${ORIGIN}"
  plan "ingress.tls_cert_path: ${TLS_CERT}"
  plan "ingress.tls_key_path: ${TLS_KEY}"
  [[ -n ${DNS_ZONE} ]] && plan "dns.zone: ${DNS_ZONE}"
  [[ -n ${INGEST_URL} ]] && plan "core.env.TAU_PLATFORM_INGEST_URL: ${INGEST_URL}"
  printf '\n.env — %s\n' "${ENV_FILE}"
  plan "APP_URL=${ORIGIN}"
  plan "TAU_WEB_ORIGIN=${ORIGIN}"
  [[ -n ${INGEST_URL} ]] && plan "TAU_PLATFORM_INGEST_URL=${INGEST_URL}"
  printf '\ncaddy — host %s\n' "${CADDY_HOST}"
  plan "install ${TLS_CERT} -> ${CADDY_TLS_CERT_PATH} (0644 root) and ${TLS_KEY} -> ${CADDY_TLS_KEY_PATH} (0600 caddy-owned; contents never printed)"
  plan "write ${CADDYFILE_PATH} (idempotent: rewrite + reload, never restart, only on content change):"
  render_caddyfile "${CADDY_HOST}" "${CORE_PORT}" "${CADDY_TLS_CERT_PATH}" "${CADDY_TLS_KEY_PATH}" | sed 's/^/  | /'
  printf '\nunits\n'
  plan "systemctl restart tau-api tau-worker; wait for 127.0.0.1:${CORE_PORT}/health (bounded timeout)"
  exit 0
fi

# This script runs unattended, as root, against a live tenant — no
# sudo-with-a-warning fallback (unlike setup-host.sh's interactive wizard
# flow): either the invoking process already IS root, or it dies here,
# before touching anything.
[[ ${EUID} -eq 0 ]] ||
  die "retarget-origin.sh must run as root (EUID=${EUID}) — it rewrites root-owned Caddy TLS material and restarts the tau-api/tau-worker systemd units; run it as root directly (sudo is not supported here)"

# ============================================================ 1. back up

# Prints the backup path on stdout (in addition to the log_info line, which
# goes to stderr) so a caller can capture it — used below to remember the
# PREVIOUS origin cert/key so they can be restored if the caddy step fails.
backup_file() { # FILE
  local file=$1 ts dest
  [[ -f ${file} ]] || return 0
  ts=$(date -u '+%Y%m%dT%H%M%SZ')
  dest="${file}.bak-${ts}"
  cp -p "${file}" "${dest}"
  log_info "backed up ${file} -> ${dest}"
  printf '%s' "${dest}"
}

log_step "1/6: back up ${CONFIG} and ${ENV_FILE}"
backup_file "${CONFIG}" >/dev/null
backup_file "${ENV_FILE}" >/dev/null

# ======================================================== 2. rewrite yaml
#
# Touches ONLY core.origin, ingress.tls_{cert,key}_path, and (when given)
# dns.zone / core.env.TAU_PLATFORM_INGEST_URL — never source.ref,
# artifacts.dir, or any secret.

log_step "2/6: rewrite ${CONFIG}"
cfg_set '.core.origin' "${ORIGIN}"
cfg_set '.ingress.tls_cert_path' "${TLS_CERT}"
cfg_set '.ingress.tls_key_path' "${TLS_KEY}"
[[ -n ${DNS_ZONE} ]] && cfg_set '.dns.zone' "${DNS_ZONE}"
[[ -n ${INGEST_URL} ]] && cfg_set '.core.env.TAU_PLATFORM_INGEST_URL' "${INGEST_URL}"
log_info "wrote core.origin=${ORIGIN} ingress.tls_cert_path=${TLS_CERT} ingress.tls_key_path=${TLS_KEY}${DNS_ZONE:+ dns.zone=${DNS_ZONE}}${INGEST_URL:+ core.env.TAU_PLATFORM_INGEST_URL=${INGEST_URL}}"

# ==================================================== 3. install the cert
#
# Back up whatever cert/key are CURRENTLY at the canonical paths before
# overwriting them — if the caddy step below fails, these are what let this
# script put the host back to serving its own (old) cert instead of the
# new one against a rolled-back Caddyfile (see the FAILURE BEHAVIOR note at
# the top of this file).

log_step '3/6: install the origin certificate'
PREV_CERT_BACKUP=$(backup_file "${CADDY_TLS_CERT_PATH}")
PREV_KEY_BACKUP=$(backup_file "${CADDY_TLS_KEY_PATH}")
install_origin_cert "${TLS_CERT}" "${TLS_KEY}"

# ============================================================ 4. rewrite .env
#
# Preserves every other line byte-for-byte — this is a targeted patch, not a
# re-render: a re-render would need secrets (TAU_ENCRYPTION_KEY,
# TAU_PASSWORD, ...) that are deliberately unavailable off-box on a hosted
# tenant.

log_step "4/6: rewrite ${ENV_FILE}"
envfile_set "${ENV_FILE}" APP_URL "${ORIGIN}"
envfile_set "${ENV_FILE}" TAU_WEB_ORIGIN "${ORIGIN}"
[[ -n ${INGEST_URL} ]] && envfile_set "${ENV_FILE}" TAU_PLATFORM_INGEST_URL "${INGEST_URL}"
log_info "wrote APP_URL=TAU_WEB_ORIGIN=${ORIGIN} to ${ENV_FILE}${INGEST_URL:+ (+ TAU_PLATFORM_INGEST_URL)}"

# ============================================================ 5. caddy

log_step "5/6: re-render + reload caddy (host ${CADDY_HOST})"
# Run in a subshell: caddy_write_and_reload die()s (exit 1) on a validation
# or reload failure, and a bare `exit` inside a function called directly
# would end this whole script before the certificate rollback below ever
# ran. `( ... )` contains that exit to the subshell; every FILE it writes
# (the real Caddyfile, via as_root) still lands for real — only the process
# exit is scoped.
if ! ( caddy_write_and_reload "$(render_caddyfile "${CADDY_HOST}" "${CORE_PORT}" "${CADDY_TLS_CERT_PATH}" "${CADDY_TLS_KEY_PATH}")" ); then
  log_error "caddy re-render/reload failed — restoring the previous origin certificate (caddy_write_and_reload already restored its own prior Caddyfile bytes on this failure path, so the host keeps serving ITS OWN cert against ITS OWN prior config)"
  [[ -n ${PREV_CERT_BACKUP} ]] && cp -p "${PREV_CERT_BACKUP}" "${CADDY_TLS_CERT_PATH}"
  [[ -n ${PREV_KEY_BACKUP} ]] && cp -p "${PREV_KEY_BACKUP}" "${CADDY_TLS_KEY_PATH}"
  die "retarget-origin.sh: caddy step failed — origin certificate rolled back to its previous value. The yaml (step 2) and .env (step 4) rewrites are still in place (see ${CONFIG}.bak-*/${ENV_FILE}.bak-* from step 1 to revert those by hand); tau-api/tau-worker were NOT restarted."
fi

# ============================================================ 6. restart

restart_core_services "${CORE_PORT}"

log_info "retarget complete: ${CADDY_HOST} now serves core on :${CORE_PORT} at ${ORIGIN}"
