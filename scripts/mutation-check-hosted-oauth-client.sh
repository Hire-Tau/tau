#!/usr/bin/env bash
# Mutation proof for hosted OAuth authority, recovery, and browser safety.
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
[[ -z $(git status --porcelain) ]] || { echo 'mutation check requires a clean worktree' >&2; exit 1; }
TMP=$(mktemp -d "$ROOT/.mutation-hosted-oauth.XXXXXX")
FILES=(
  apps/core/src/services/integrations/authorization/db-state-repository.ts
  apps/core/src/services/integrations/authorization/service.ts
  apps/core/src/services/integrations/authorization/flow-repository.ts
  apps/core/src/services/integrations/authorization/connection-lease.ts
  apps/core/src/services/integrations/authorization/refresh-service.ts
  apps/core/src/services/integrations/authorization/refresh-worker.ts
  apps/core/src/services/integrations/authorization/oauth-operational-alert.ts
  apps/core/src/services/integrations/authorization/revocation-worker.ts
  apps/core/src/services/integrations/credential-cleanup-worker.ts
  apps/core/src/services/integrations/notion/connection-authorizer.ts
  apps/core/src/services/integrations/db-connection-repository.ts
  apps/core/src/services/integrations/connection-service.ts
  apps/core/src/services/integrations/runtime.ts
  apps/core/src/services/integrations/runtime-gate.ts
  apps/core/src/services/integrations/projection/protected-env.ts
  apps/core/src/services/integrations/projection/agent-refs.ts
  apps/core/src/services/integrations/projection/load-effective-toolchain.ts
  apps/core/src/entities/agent-runners/base.ts
  apps/core/src/services/secrets/managed.ts
  apps/web/src/lib/oauthCallbackBootstrap.ts
  apps/web/src/main.tsx
  apps/web/src/components/integrations/OAuthCallbackPage.tsx
  apps/web/src/components/integrations/NotionIntegrationSettings.tsx
)
restore_files() { for f in "${FILES[@]}"; do cp "$TMP/$f" "$f"; done; }
restore() { restore_files; rm -rf "$TMP"; }
trap restore EXIT INT TERM
for f in "${FILES[@]}"; do mkdir -p "$TMP/$(dirname "$f")"; cp "$f" "$TMP/$f"; done
replace_once() { python3 - "$1" "$2" "$3" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text(); old,new=sys.argv[2:]
if s.count(old)!=1: raise SystemExit(f'expected one match in {p}, found {s.count(old)}')
p.write_text(s.replace(old,new,1))
PY
}
kill_mutation() {
  local name="$1" target="$2"; shift 2
  if [[ -n "${MUTATION_FILTER:-}" ]] && ! [[ "$name" =~ $MUTATION_FILTER ]]; then echo "skipped (filter): $name"; return; fi
  restore_files
  local path="${target%%:*}" filter="${target#*:}"
  if ! bun test "$path" -t "$filter" >"$TMP/baseline" 2>&1; then
    echo "baseline failed: $name" >&2; tail -40 "$TMP/baseline" >&2; exit 1
  fi
  while [[ $# -ge 3 ]]; do replace_once "$1" "$2" "$3"; shift 3; done
  if bun test "$path" -t "$filter" >"$TMP/out" 2>&1; then
    echo "mutation survived: $name" >&2; tail -40 "$TMP/out" >&2; exit 1
  fi
  if grep -Eq '^# Unhandled error between tests|^error: (Unexpected|Cannot find module|ParseError|SyntaxError)' "$TMP/out"; then
    echo "mutation failed for infrastructure rather than behavior: $name" >&2
    tail -40 "$TMP/out" >&2
    exit 1
  fi
  if ! grep -Fq '(fail)' "$TMP/out"; then
    echo "mutation did not report a named assertion failure: $name" >&2
    tail -40 "$TMP/out" >&2
    exit 1
  fi
  echo "killed: $name"
}

kill_mutation 'claim omits user binding' \
  'apps/core/src/services/integrations/authorization/db-state-repository.test.ts:hosted flow claim binds' \
  apps/core/src/services/integrations/authorization/db-state-repository.ts '            eq(integrationOauthStates.userId, input.userId),' '            sql`true`,'
kill_mutation 'claim omits provider binding' \
  'apps/core/src/services/integrations/authorization/db-state-repository.test.ts:hosted flow claim binds' \
  apps/core/src/services/integrations/authorization/db-state-repository.ts '            eq(integrationOauthStates.providerKey, input.providerKey),' '            sql`true`,'
kill_mutation 'claim accepts the wrong handle' \
  'apps/core/src/services/integrations/authorization/db-state-repository.test.ts:hosted flow claim binds' \
  apps/core/src/services/integrations/authorization/db-state-repository.ts '                eq(integrationOauthStates.completionHandleHash, input.handleHash),' '                sql`true`,'
kill_mutation 'claim ignores initial expiry' \
  'apps/core/src/services/integrations/authorization/db-state-repository.test.ts:initially expired hosted flow' \
  apps/core/src/services/integrations/authorization/db-state-repository.ts $'              and(\n                isNull(integrationOauthStates.completionHandleHash),\n                gt(integrationOauthStates.expiresAt, sql`now()`)\n              ),' $'              and(\n                isNull(integrationOauthStates.completionHandleHash),\n                sql`true`\n              ),'
kill_mutation 'authorization host allowlist is bypassed' \
  'apps/core/src/services/integrations/authorization/service.test.ts:rejects a broker authorization URL outside' \
  apps/core/src/services/integrations/authorization/service.ts '  return Boolean(adapter?.authorizeHosts.includes(url.host))' '  return true'
kill_mutation 'installed receipt lookup no longer short-circuits lifecycle work' \
  'apps/core/src/services/integrations/authorization/service.test.ts:installed receipt replay survives a deployment authority transition' \
  apps/core/src/services/integrations/authorization/service.ts '    if (receiptMatches && prior?.installKind) return { returnTo: prior.returnTo }' '    if (false) return { returnTo: prior!.returnTo }'
kill_mutation 'pending receipt lookup is bypassed before lifecycle resume' \
  'apps/core/src/services/integrations/notion/connection-authorizer.test.ts:installed connect replay never overrides' \
  apps/core/src/services/integrations/notion/connection-authorizer.ts '      if (receipt.installKind) return' '      if (false && receipt.installKind) return' \
  apps/core/src/services/integrations/notion/connection-authorizer.ts '    if (receipt?.installKind) return
    try {' '    if (false && receipt?.installKind) return
    try {'
kill_mutation 'duplicate completion ignores its flow-owned connection' \
  'apps/core/src/services/integrations/notion/connection-authorizer.test.ts:brokered connect retries reuse one authorization flow' \
  apps/core/src/services/integrations/notion/connection-authorizer.ts '      if (receipt.installKind) return' '      if (false && receipt.installKind) return' \
  apps/core/src/services/integrations/notion/connection-authorizer.ts '      const existing = await this.#dependencies.repository.getByAuthorizationFlow(authorizationFlowId)' '      const existing = null'
kill_mutation 'terminal receipt becomes stageable' \
  'apps/core/src/services/integrations/authorization/flow-repository.test.ts:staging and terminal dispositions are monotonic' \
  apps/core/src/services/integrations/authorization/flow-repository.ts '          isNull(integrationAuthorizationFlowReceipts.terminalAt),' '          sql`true`,' \
  apps/core/src/services/integrations/authorization/flow-repository.ts '          isNull(integrationAuthorizationFlowReceipts.revocationRequiredAt),' '          sql`true`,' \
  apps/core/src/services/integrations/authorization/flow-repository.ts '          isNull(integrationAuthorizationFlowReceipts.cleanupRequiredAt),' '          sql`true`,'
kill_mutation 'cleanup ownership fact is overwritten on retry' \
  'apps/core/src/services/integrations/authorization/flow-repository.test.ts:cleanup ownership facts are write-once' \
  apps/core/src/services/integrations/authorization/flow-repository.ts '          cleanupRequiredAt: receipt.cleanupRequiredAt ?? now,' '          cleanupRequiredAt: now,'
kill_mutation 'installed receipt fact is overwritten on replay' \
  'apps/core/src/services/integrations/db-connection-repository.concurrent.test.ts:connect enable atomically records an immutable authorization receipt' \
  apps/core/src/services/integrations/db-connection-repository.ts '        if (receipt.installKind) {' '        if (false && receipt.installKind) {'
kill_mutation 'expiry sweep omits revocation obligation' \
  'apps/core/src/services/integrations/authorization/flow-repository.test.ts:expired staged flow becomes terminal' \
  apps/core/src/services/integrations/authorization/flow-repository.ts '            ...(receipt.stagingStartedAt ? { revocationRequiredAt: now } : {}),' '            ...(receipt.stagingStartedAt ? {} : {}),'
kill_mutation 'no-browser settlement omits cleanup completion' \
  'apps/core/src/services/integrations/notion/broker-lifecycle.e2e.test.ts:expired staged flow drains' \
  apps/core/src/services/integrations/credential-cleanup-worker.ts '.set({ cleanupSettledAt: sql`transaction_timestamp()`, updatedAt: sql`transaction_timestamp()` })' '.set({ cleanupSettledAt: null, updatedAt: sql`transaction_timestamp()` })'
kill_mutation 'refresh skips in-lease authority guard' \
  'apps/core/src/services/integrations/authorization/refresh-service.test.ts:authority mismatch requires reauthorization' \
  apps/core/src/services/integrations/authorization/refresh-service.ts '    if (connection.clientAuthority !== this.#dependencies.transport.authority) {' '    if (false) {' \
  apps/core/src/services/integrations/authorization/refresh-service.ts '      if (currentConnection.clientAuthority !== this.#dependencies.transport.authority) {' '      if (false) {'
kill_mutation 'refresh CAS ignores token revision' \
  'apps/core/src/services/integrations/authorization/refresh-service.test.ts:atomically rotates the access and refresh pair once' \
  apps/core/src/services/integrations/authorization/refresh-service.ts '      if (observedRevision !== undefined && current.tokenRevision !== observedRevision) {' '      if (false) {'
kill_mutation 'operation in flight becomes terminal' \
  'apps/core/src/services/integrations/authorization/refresh-service.test.ts:operation in flight remains degraded' \
  apps/core/src/services/integrations/authorization/refresh-service.ts '        if (isTerminalRefreshFailure(failure)) {' "        if (isTerminalRefreshFailure(failure) || failure.code === 'operation_in_flight') {"
kill_mutation 'retryable refresh body becomes terminal' \
  'apps/core/src/services/integrations/authorization/refresh-service.test.ts:retryable broker invalid_grant body degrades' \
  apps/core/src/services/integrations/authorization/refresh-service.ts '    !failure.retryable &&' '    true &&'
kill_mutation 'OAuth app configuration becomes a terminal refresh failure' \
  'apps/core/src/services/integrations/authorization/refresh-service.test.ts:missing local client credentials degrade' \
  apps/core/src/services/integrations/authorization/refresh-service.ts "      failure.code === 'workspace_mismatch')" "      failure.code === 'workspace_mismatch' || failure.code === 'oauth_app_unconfigured')"
kill_mutation 'broker alert failure escapes the persisted degraded lifecycle' \
  'apps/core/src/services/integrations/authorization/refresh-service.test.ts:broker access alert failure cannot change' \
  apps/core/src/services/integrations/authorization/refresh-service.ts $'          } catch {\n            // Durable alert delivery never changes' $'          } catch (error) {\n            throw error\n            // Durable alert delivery never changes'
kill_mutation 'broker denial skips durable operator alert' \
  'apps/core/src/services/integrations/authorization/refresh-service.test.ts:broker access alert failure cannot change' \
  apps/core/src/services/integrations/authorization/refresh-service.ts '            await this.#dependencies.operatorAlert?.({' '            await undefined?.({'
kill_mutation 'retired credential enqueue uses replacement authority' \
  'apps/core/src/services/integrations/db-connection-repository.concurrent.test.ts:local reconnect clears retired broker ownership' \
  apps/core/src/services/integrations/db-connection-repository.ts $'          credentialRef: connection.credentialRef,\n          clientAuthority: connection.clientAuthority,\n          authorizationFlowId: priorFlowOwnsArtifact' $'          credentialRef: connection.credentialRef,\n          clientAuthority: input.clientAuthority,\n          authorizationFlowId: priorFlowOwnsArtifact'
kill_mutation 'revoke guard resolves current authority before the external act' \
  'apps/core/src/services/integrations/authorization/revocation-worker.test.ts:routes revocation by persisted job authority' \
  apps/core/src/services/integrations/authorization/revocation-worker.ts 'this.#dependencies.revocationTransports.resolve(job.clientAuthority)' "this.#dependencies.revocationTransports.resolve('local')"
kill_mutation 'hosted denial calls completion' \
  'apps/web/src/components/integrations/OAuthCallbackPage.test.tsx:status=denied shows a cancelled message' \
  apps/web/src/lib/oauthCallbackBootstrap.ts "    if (status === 'denied') {" "    if (false && status === 'denied') {"
kill_mutation 'callback history retains URL material' \
  'apps/web/src/components/integrations/OAuthCallbackPage.test.tsx:strips the completion handle from the URL before any network call' \
  apps/web/src/lib/oauthCallbackBootstrap.ts "  window.history.replaceState(state, '', window.location.pathname)" '  void state'
kill_mutation 'hosted settings render local client fields' \
  'apps/web/src/components/integrations/NotionIntegrationSettings.test.tsx:hosted mode offers Connect Notion' \
  apps/web/src/components/integrations/NotionIntegrationSettings.tsx "      {settings?.authority === 'local' && !settings.configured && canWrite && (" "      {settings?.authority !== 'local' && settings.configured && canWrite && ("
kill_mutation 'hosted settings render local client guidance' \
  'apps/web/src/components/integrations/NotionIntegrationSettings.test.tsx:hosted mode offers Connect Notion' \
  apps/web/src/components/integrations/NotionIntegrationSettings.tsx "      ) : settings.authority === 'platform_broker' ? (" '      ) : false ? ('
kill_mutation 'live local installer releases its revocation fence' \
  'apps/core/src/services/integrations/notion/broker-lifecycle.e2e.test.ts:live local installer fences' \
  apps/core/src/services/integrations/notion/connection-authorizer.ts ': { credentialRef: `__integration-credential:rollback:${this.#uuid()}:bearer` }' ': undefined'
kill_mutation 'production registry wiring treats manual Bigbrain as OAuth' \
  'apps/core/src/entities/agent-runners/base.integration-tools.test.ts:managed registry wiring applies deployment authority' \
  apps/core/src/entities/agent-runners/base.ts "plugin(provider)?.authorization.kind === 'oauth2'" "plugin(provider)?.authorization.kind !== 'oauth2'"
kill_mutation 'manual providers inherit the deployment OAuth authority' \
  'apps/core/src/services/integrations/runtime-gate.test.ts:managed deployment authority does not deny' \
  apps/core/src/services/integrations/runtime-gate.ts '    if (currentAuthority && connection.clientAuthority !== currentAuthority) {' '    if (true && connection.clientAuthority !== currentAuthority) {'
kill_mutation 'runtime use ignores historical client authority' \
  'apps/core/src/services/integrations/runtime-gate.test.ts:historical client authority is rejected' \
  apps/core/src/services/integrations/runtime-gate.ts '    if (currentAuthority && connection.clientAuthority !== currentAuthority) {' '    if (false && currentAuthority && connection.clientAuthority !== currentAuthority) {'
kill_mutation 'hosted projection exposes historical local Notion material' \
  'apps/core/src/services/integrations/db-connection-repository.concurrent.test.ts:hosted projection emits zero material' \
  apps/core/src/services/integrations/projection/protected-env.ts "    if (plugin.authorization.kind === 'oauth2' && connection.clientAuthority !== resolveOAuthAuthority()) continue" "    if (false && plugin.authorization.kind === 'oauth2' && connection.clientAuthority !== resolveOAuthAuthority()) continue"
kill_mutation 'hosted projection exposes historical local Notion refs' \
  'apps/core/src/services/integrations/db-connection-repository.concurrent.test.ts:hosted projection emits zero material' \
  apps/core/src/services/integrations/projection/agent-refs.ts "    if (plugin.authorization.kind === 'oauth2' && row.clientAuthority !== resolveOAuthAuthority()) continue" "    if (false && plugin.authorization.kind === 'oauth2' && row.clientAuthority !== resolveOAuthAuthority()) continue"
kill_mutation 'hosted projection exposes historical local Notion toolchain' \
  'apps/core/src/services/integrations/db-connection-repository.concurrent.test.ts:hosted projection emits zero material' \
  apps/core/src/services/integrations/projection/load-effective-toolchain.ts "    if (plugin.authorization.kind === 'oauth2' && connection.clientAuthority !== resolveOAuthAuthority()) continue" "    if (false && plugin.authorization.kind === 'oauth2' && connection.clientAuthority !== resolveOAuthAuthority()) continue"
kill_mutation 'revocation claim stops at a busy queue head' \
  'apps/core/src/services/integrations/db-connection-repository.concurrent.test.ts:revocation claim skips a busy oldest artifact' \
  apps/core/src/services/integrations/authorization/revocation-worker.ts '        .limit(20)' '        .limit(1)'
kill_mutation 'refresh startup excludes current-authority rows' \
  'apps/core/src/services/integrations/db-connection-repository.concurrent.test.ts:refresh candidate keyset admits the initial' \
  apps/core/src/services/integrations/db-connection-repository.ts '          afterId === null ? undefined : gt(integrationConnections.id, afterId)' '          afterId === null ? ne(integrationConnections.clientAuthority, currentAuthority) : gt(integrationConnections.id, afterId)'
kill_mutation 'refresh reconciliation repeats the first fifty rows' \
  'apps/core/src/services/integrations/authorization/refresh-worker.test.ts:rotates stable batches' \
  apps/core/src/services/integrations/authorization/refresh-worker.ts '        const cursor = cursors.get(providerKey) ?? null' "        const cursor = authorityFilter === 'matching' ? null : (cursors.get(providerKey) ?? null)"
kill_mutation 'live local reconnect releases its revocation fence' \
  'apps/core/src/services/integrations/notion/broker-lifecycle.e2e.test.ts:live local reconnect fences' \
  apps/core/src/services/integrations/notion/connection-authorizer.ts '      ...(localArtifact ? [revocationArtifactLeaseResource(localArtifact.credentialRef)] : []),' "      ...(localArtifact && input.intent.intent !== 'reconnect' ? [revocationArtifactLeaseResource(localArtifact.credentialRef)] : []),"
kill_mutation 'periodic validation reaches provider before OAuth authority reconciliation' \
  'apps/core/src/services/integrations/connection-service.test.ts:historical local OAuth validation reconciles authority' \
  apps/core/src/services/integrations/connection-service.ts '    if (await this.#reconcileAuthority(connection)) return this.safeView(await this.#mustGet(id))' '    if (false && (await this.#reconcileAuthority(connection))) return this.safeView(await this.#mustGet(id))'
kill_mutation 'explicit enable reaches provider before OAuth authority reconciliation' \
  'apps/core/src/services/integrations/connection-service.test.ts:historical local OAuth explicit enable fails closed' \
  apps/core/src/services/integrations/connection-service.ts $'    if (await this.#reconcileAuthority(connection))\n      throw new Error(\'Integration authentication failed: client_authority_mismatch\')' $'    if (false && (await this.#reconcileAuthority(connection)))\n      throw new Error(\'Integration authentication failed: client_authority_mismatch\')'
kill_mutation 'terminal authority CAS omits atomic projection invalidation' \
  'apps/core/src/services/integrations/db-connection-repository.concurrent.test.ts:reauthorization CAS atomically supersedes' \
  apps/core/src/services/integrations/db-connection-repository.ts $'      await this.hooks.afterTerminalAuthConnectionUpdate?.()\n      const usage = await usageInTransaction(tx, input.id)\n      for (const squad of usage.squads) await invalidateProjection(tx, squad.id, connection.providerKey)' $'      await this.hooks.afterTerminalAuthConnectionUpdate?.()\n      const usage = await usageInTransaction(tx, input.id)\n      void usage'
kill_mutation 'authority mismatch omits its durable operator signal' \
  'apps/core/src/services/integrations/connection-service.test.ts:historical local OAuth validation reconciles authority' \
  apps/core/src/services/integrations/connection-service.ts '    await this.#operatorAlert?.({' '    await (async () => {})?.({'
kill_mutation 'normal removal bypasses the refresh connection lease' \
  'apps/core/src/services/integrations/notion/broker-lifecycle.e2e.test.ts:removal waits for an admitted refresh' \
  apps/core/src/services/integrations/connection-service.ts '    const removed = this.#authorizationLease' '    const removed = undefined'
kill_mutation 'multi-resource lease omits the shared canonical lock' \
  'apps/core/src/services/integrations/notion/connection-authorizer.test.ts:shared reconnect resources never overlap' \
  apps/core/src/services/integrations/authorization/connection-lease.ts '          for (const key of keys) {' '          for (const key of keys.slice(0, 1)) {'
kill_mutation 'stale validation overwrites terminal reauthorization state' \
  'apps/core/src/services/integrations/db-connection-repository.concurrent.test.ts:reauthorization CAS atomically supersedes' \
  apps/core/src/services/integrations/db-connection-repository.ts "        if (!connection || connection.authState === 'reauthorization_required') return false" '        if (!connection) return false'
kill_mutation 'enable reaches provider for an already-terminal connection' \
  'apps/core/src/services/integrations/connection-service.test.ts:enable rejects an already-terminal connection' \
  apps/core/src/services/integrations/connection-service.ts "    if (connection.authState === 'reauthorization_required')" '    if (false)'
kill_mutation 'enable restores a concurrent terminal refresh' \
  'apps/core/src/services/integrations/db-connection-repository.concurrent.test.ts:terminal enable preserves broker receipt' \
  apps/core/src/services/integrations/db-connection-repository.ts $'        !connection ||\n        connection.materialRevision !== input.materialRevision ||\n        connection.authState === \'reauthorization_required\'\n      )\n        return false\n      if (!input.authorizationFlowId)' $'        !connection || connection.materialRevision !== input.materialRevision\n      )\n        return false\n      if (!input.authorizationFlowId)'
kill_mutation 'local pending failure reacquires a nested removal lease' \
  'apps/core/src/services/integrations/notion/connection-authorizer.test.ts:two concurrent post-create local failures drain' \
  apps/core/src/services/integrations/notion/connection-authorizer.ts '      await this.#dependencies.connectionService.rollbackPendingLocal(connectionId, stagedCredentialRef)' '      await this.#dependencies.connectionService.remove(connectionId, `user:${userId}`, true)'
kill_mutation 'successful authentication recovery omits projection scheduling' \
  'apps/core/src/services/integrations/db-connection-repository.concurrent.test.ts:expired or provider-rejected refresh failure' \
  apps/core/src/services/integrations/db-connection-repository.ts $'        if (connection.enabled && !wasProjectionEligible) {\n          const usage = await usageInTransaction(tx, input.id)\n          for (const squad of usage.squads) await invalidateProjection(tx, squad.id, connection.providerKey)\n        }' ''
kill_mutation 'runtime auth failure overwrites terminal reauthorization' \
  'apps/core/src/services/integrations/db-connection-repository.concurrent.test.ts:reauthorization CAS atomically supersedes' \
  apps/core/src/services/integrations/db-connection-repository.ts $'          lastErrorCode: \'invalid_auth\',\n          updatedAt: new Date(),\n        })\n        .where(\n          and(\n            eq(integrationConnections.id, input.id),\n            eq(integrationConnections.materialRevision, input.materialRevision),\n            ne(integrationConnections.authState, \'reauthorization_required\')' $'          lastErrorCode: \'invalid_auth\',\n          updatedAt: new Date(),\n        })\n        .where(\n          and(\n            eq(integrationConnections.id, input.id),\n            eq(integrationConnections.materialRevision, input.materialRevision),\n            sql`true`'
kill_mutation 'invalidating refresh failure overwrites terminal reauthorization' \
  'apps/core/src/services/integrations/db-connection-repository.concurrent.test.ts:reauthorization CAS atomically supersedes' \
  apps/core/src/services/integrations/db-connection-repository.ts $'            nextValidationAt: new Date(now.getTime() + 60_000),\n            updatedAt: now,\n          })\n          .where(\n            and(\n              eq(integrationConnections.id, input.id),\n              eq(integrationConnections.materialRevision, input.materialRevision),\n              ne(integrationConnections.authState, \'reauthorization_required\')' $'            nextValidationAt: new Date(now.getTime() + 60_000),\n            updatedAt: now,\n          })\n          .where(\n            and(\n              eq(integrationConnections.id, input.id),\n              eq(integrationConnections.materialRevision, input.materialRevision),\n              sql`true`'
kill_mutation 'degraded refresh failure mutates terminal reauthorization' \
  'apps/core/src/services/integrations/db-connection-repository.concurrent.test.ts:reauthorization CAS atomically supersedes' \
  apps/core/src/services/integrations/db-connection-repository.ts $'        nextValidationAt: new Date(now.getTime() + 60_000),\n        updatedAt: now,\n      })\n      .where(\n        and(\n          eq(integrationConnections.id, input.id),\n          eq(integrationConnections.materialRevision, input.materialRevision),\n          ne(integrationConnections.authState, \'reauthorization_required\')' $'        nextValidationAt: new Date(now.getTime() + 60_000),\n        updatedAt: now,\n      })\n      .where(\n        and(\n          eq(integrationConnections.id, input.id),\n          eq(integrationConnections.materialRevision, input.materialRevision),\n          sql`true`'
kill_mutation 'post-validation local rollback rejects its exact authenticated row' \
  'apps/core/src/services/integrations/notion/broker-lifecycle.e2e.test.ts:two production-backed local post-create failures drain' \
  apps/core/src/services/integrations/db-connection-repository.ts "              eq(integrationConnections.authState, 'authenticated')," "              eq(integrationConnections.authState, 'pending'),"
kill_mutation 'authority mismatch alert is misclassified as broker denial' \
  'apps/core/src/services/integrations/authorization/oauth-operational-alert.test.ts:authority mismatch alert has a distinct' \
  apps/core/src/services/integrations/authorization/oauth-operational-alert.ts "          alert.safeCode === 'client_authority_mismatch' ? 'client_authority_mismatch' : 'broker_access_denied'," "          'broker_access_denied',"
kill_mutation 'authority mismatch CAS loser emits a stale alert' \
  'apps/core/src/services/integrations/connection-service.test.ts:authority mismatch CAS loser emits no stale operator alert' \
  apps/core/src/services/integrations/connection-service.ts '    if (updated) {' '    if (true) {'
kill_mutation 'projection runtime resolves its manager eagerly during boot' \
  'apps/core/src/services/integrations/runtime-gate.test.ts:production projection builders defer manager resolution' \
  apps/core/src/services/integrations/runtime-gate.ts '    get: resolve,' '    value: resolve(),'
kill_mutation 'projection runtime drops the agent lifecycle generation fence' \
  'apps/core/src/services/integrations/runtime-gate.test.ts:production projection builders defer manager resolution' \
  apps/core/src/services/integrations/runtime-gate.ts '        options: { ...input.optionsForAgent(agent, sandboxId), lifecycleGeneration },' '        options: { ...input.optionsForAgent(agent, sandboxId), lifecycleGeneration: undefined },'
kill_mutation 'OAuth bootstrap removes the development backend safeguard bar' \
  'apps/web/src/lib/oauthCallbackBootstrap.test.ts:production bootstrap captures OAuth material' \
  apps/web/src/main.tsx '            <DevBackendBar />' ''
kill_mutation 'self-hosted callback URL loses narrow wrapping' \
  'apps/web/src/components/integrations/NotionIntegrationSettings.test.tsx:starts Notion OAuth' \
  apps/web/src/components/integrations/NotionIntegrationSettings.tsx ' className="break-all [overflow-wrap:anywhere]"' ''
kill_mutation 'Notion settings error remains an indefinite loading state' \
  'apps/web/src/components/integrations/NotionIntegrationSettings.test.tsx:failed OAuth settings query shows a safe retry action' \
  apps/web/src/components/integrations/NotionIntegrationSettings.tsx '      {oauthApp.isError ? (' '      {false ? ('
kill_mutation 'OAuth callback working status loses live-region semantics' \
  'apps/web/src/components/integrations/OAuthCallbackPage.test.tsx:strips the completion handle' \
  apps/web/src/components/integrations/OAuthCallbackPage.tsx $'        <p role="status" aria-live="polite" className="mt-2 text-sm text-muted">\n          Finishing the secure connection…' $'        <p className="mt-2 text-sm text-muted">\n          Finishing the secure connection…'
kill_mutation 'revocation test repository claims foreign fixture work' \
  'apps/core/src/services/integrations/notion/broker-lifecycle.e2e.test.ts:two production-backed local post-create failures drain' \
  apps/core/src/services/integrations/authorization/revocation-worker.ts $'        this.eligibleCredentialRefs\n          ?' $'        false\n          ?'
kill_mutation 'cleanup test repository claims foreign fixture work' \
  'apps/core/src/services/integrations/notion/broker-lifecycle.e2e.test.ts:two production-backed local post-create failures drain' \
  apps/core/src/services/integrations/credential-cleanup-worker.ts $'            this.eligibleCredentialRefs\n              ?' $'            false\n              ?'
kill_mutation 'failed manual create preserves its unowned credential' \
  'apps/core/src/services/integrations/connection-service.test.ts:failed manual create retires its unowned credential' \
  apps/core/src/services/integrations/connection-service.ts '          await this.#retireCredential(credentialRef)' ''
kill_mutation 'local pending create discards its durable drain obligation' \
  'apps/core/src/services/integrations/notion/broker-lifecycle.e2e.test.ts:local process death after pending create' \
  apps/core/src/services/integrations/db-connection-repository.ts $'          .for(\'update\')\n        if (adopted.length !== 1)' $'          .for(\'update\')\n        await tx.delete(integrationRevocationJobs).where(eq(integrationRevocationJobs.credentialRef, adoptStagedRevocationRef))\n        if (adopted.length !== 1)'
kill_mutation 'retired Notion aliases regain value resolution and delivery' \
  'apps/core/src/services/secrets/managed.test.ts:retired Notion OAuth declarations stay managed' \
  apps/core/src/services/secrets/managed.ts "  'exe-provider-ssh-key': { envKey: 'EXE_PROVIDER_SSH_KEY', encoding: 'base64' }," "  'exe-provider-ssh-key': { envKey: 'EXE_PROVIDER_SSH_KEY', encoding: 'base64' }, '__integration-oauth-client-id:notion': { envKey: 'NOTION_OAUTH_CLIENT_ID' }, '__integration-oauth-client-secret:notion': { envKey: 'NOTION_OAUTH_CLIENT_SECRET' },"
kill_mutation 'retired managed names become public' \
  'apps/core/src/services/secrets/managed.test.ts:retired Notion OAuth declarations stay managed' \
  apps/core/src/services/secrets/managed.ts ' && !RETIRED_PUBLIC_MANAGED_ENV_KEYS.has(key)' ''

restore_files
git diff --exit-code -- "${FILES[@]}"
echo 'all hosted OAuth client mutations were killed'
