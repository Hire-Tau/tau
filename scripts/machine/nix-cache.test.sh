#!/usr/bin/env bash
# Real Git-object cache regression, Linux (flock + GNU timeout required).
set -euo pipefail
TARGET="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/box-provision.sh"
eval "$(awk '/^NIX_CACHE_ROOT=/ {copy=1} /^ensure_dirs\(\)/ {exit} copy' "${TARGET}")"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
NIX_CACHE_ROOT="${TMP}/shared"
source_home="${TMP}/prewarm"
source_cache="${source_home}/.cache/nix/tarball-cache"
target_cache="${TMP}/box/.cache/nix/tarball-cache"
other="${TMP}/other"
shared="${NIX_CACHE_ROOT}/tarball-cache"
for cache in "${source_cache}" "${target_cache}" "${other}"; do git init --bare --quiet "${cache}"; done
public="$(printf 'public default toolchain' | git --git-dir="${source_cache}" hash-object -w --stdin)"
printf 'public default toolchain' | git --git-dir="${target_cache}" hash-object -w --stdin >/dev/null
private="$(printf 'private custom dependency' | git --git-dir="${target_cache}" hash-object -w --stdin)"
other_oid="$(printf 'existing alternate' | git --git-dir="${other}" hash-object -w --stdin)"
printf '%s\n' "${other}/objects" >"${target_cache}/objects/info/alternates"
printf 'private fetcher metadata' >"${TMP}/box/.cache/nix/fetcher-cache.sqlite"

# The fixture's cache paths are isolated; only privilege dropping is stubbed.
SUDO=()
user_home() { printf '%s' "${source_home}"; }
run_as_box() { "$@"; }
SANDBOX_ID=devbox-prewarm-agent-test-machine
UNIX_USER="box_$(printf '%s' "${SANDBOX_ID}" | sha256sum | cut -c1-12)"
# CI's ordinary user can exercise the publisher in its own temporary tree.
# Real root-only admission is covered separately by the CLI guard test.
init_shared_nix_cache() {
  local name
  for name in tarball-cache tarball-cache-v2; do git init --bare --quiet "${NIX_CACHE_ROOT}/${name}"; done
}
id() { if [ "${1:-}" = -u ]; then printf '0\n'; else command id "$@"; fi; }
publish_nix_cache
attach_nix_cache "${target_cache}" "${shared}"
[ ! -f "${target_cache}/objects/${public:0:2}/${public:2}" ]
[ "$(git --git-dir="${target_cache}" cat-file -p "${public}")" = 'public default toolchain' ]
[ "$(git --git-dir="${target_cache}" cat-file -p "${private}")" = 'private custom dependency' ]
[ "$(git --git-dir="${target_cache}" cat-file -p "${other_oid}")" = 'existing alternate' ]
! git --git-dir="${shared}" cat-file -e "${private}" 2>/dev/null
[ "$(cat "${TMP}/box/.cache/nix/fetcher-cache.sqlite")" = 'private fetcher metadata' ]
echo 'PASS existing cache deduplication preserves private objects, metadata and alternates'

fresh="${TMP}/new-box/cache"
attach_nix_cache "${fresh}" "${shared}"
# Writing an already-shared object must not allocate a local loose copy.
printf 'public default toolchain' | git --git-dir="${fresh}" hash-object -w --stdin >/dev/null
[ ! -f "${fresh}/objects/${public:0:2}/${public:2}" ]
[ "$(git --git-dir="${fresh}" cat-file -p "${public}")" = 'public default toolchain' ]
echo 'PASS fresh boxes reuse shared objects without copying'

before="$(find "${shared}/objects/pack" -type f | sort)"
publish_nix_cache
[ "$(find "${shared}/objects/pack" -type f | sort)" = "${before}" ]
attach_nix_cache "${target_cache}" "${shared}"
[ "$(grep -Fxc "${shared}/objects" "${target_cache}/objects/info/alternates")" = 1 ]
echo 'PASS publication and attachment are idempotent'

second="$(printf 'new public object' | git --git-dir="${source_cache}" hash-object -w --stdin)"
publish_nix_cache
attach_nix_cache "${fresh}" "${shared}"
[ "$(git --git-dir="${fresh}" cat-file -p "${public}")" = 'public default toolchain' ]
[ "$(git --git-dir="${fresh}" cat-file -p "${second}")" = 'new public object' ]
echo 'PASS later publication preserves old objects and reaches existing boxes'

# Nix uses its own object writer and can recreate loose objects even with
# an alternate. Simulate that write, then verify cleanup runs again even
# though the shared store has not changed.
mkdir -p "${target_cache}/objects/${public:0:2}"
cp "${source_cache}/objects/${public:0:2}/${public:2}" "${target_cache}/objects/${public:0:2}/${public:2}"
timeout() { return 124; }
attach_nix_cache "${target_cache}" "${shared}"
[ -f "${target_cache}/objects/${public:0:2}/${public:2}" ]
[ "$(git --git-dir="${target_cache}" cat-file -p "${public}")" = 'public default toolchain' ]
unset -f timeout
attach_nix_cache "${target_cache}" "${shared}"
[ ! -f "${target_cache}/objects/${public:0:2}/${public:2}" ]
echo 'PASS recreated loose objects are cleaned and bounded cleanup safely retries'

SANDBOX_ID=agent-ordinary
if publish_nix_cache 2>/dev/null; then echo 'FAIL ordinary box published' >&2; exit 1; fi
echo 'PASS ordinary agent publication refused'
echo '6 cache integration checks passed'
