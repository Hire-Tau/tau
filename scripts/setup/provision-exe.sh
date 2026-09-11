#!/usr/bin/env bash
# provision-exe.sh — compat shim. provision-exe.sh was renamed provision.sh
# (it grew a provider seam beyond exe.dev — Hetzner etc.); this name still
# works so existing muscle memory / bookmarks keep functioning.
exec "$(dirname "$0")/provision.sh" "$@"
