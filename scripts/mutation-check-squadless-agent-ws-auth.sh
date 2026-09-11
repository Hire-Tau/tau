#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CORE="$ROOT/apps/core"
MANAGER="$CORE/src/services/ws/manager.ts"
LIFECYCLE="$CORE/src/services/agent/lifecycle.ts"
TMP=$(mktemp -d)
cp "$MANAGER" "$TMP/manager.ts"
cp "$LIFECYCLE" "$TMP/lifecycle.ts"
cleanup() {
  cp "$TMP/manager.ts" "$MANAGER"
  cp "$TMP/lifecycle.ts" "$LIFECYCLE"
  rm -rf "$TMP"
}
trap cleanup EXIT

mutate_manager() {
  local name=$1 old=$2 new=$3 pattern=$4
  cp "$TMP/manager.ts" "$MANAGER"
  OLD="$old" NEW="$new" FILE="$MANAGER" python3 - <<'PY'
import os
p=os.environ['FILE']; s=open(p).read(); old=os.environ['OLD']; new=os.environ['NEW']
if s.count(old) != 1: raise SystemExit(f'mutation seam count was {s.count(old)}, expected 1')
open(p, 'w').write(s.replace(old, new))
PY
  set +e
  (cd "$CORE" && bun test src/services/ws/manager.test.ts --test-name-pattern "$pattern") >/dev/null 2>&1
  local status=$?
  set -e
  if [[ $status -eq 0 ]]; then echo "SURVIVED: $name"; exit 1; fi
  echo "KILLED: $name"
}

mutate_manager owner-equality \
  "if (scope.kind === 'owner') return identityUserId(client.identity) === scope.ownerUserId" \
  "if (scope.kind === 'owner') return identityUserId(client.identity) !== null" \
  "authorizes squad-less agent subscriptions"
mutate_manager global-before-owner \
  "  private async canAccessTopicScope(client: Client, scope: TopicScope): Promise<boolean> {" \
  $'  private async canAccessTopicScope(client: Client, scope: TopicScope): Promise<boolean> {\n    if ((await this.getAccessible(client)) === '\''all'\'') return true' \
  "authorizes squad-less agent subscriptions"
mutate_manager owner-impersonation \
  "if (scope.kind === 'owner') return identityUserId(client.identity) === scope.ownerUserId" \
  "if (scope.kind === 'owner') return client.identity.type === 'user' || client.identity.type === 'agent'" \
  "authorizes squad-less agent subscriptions"
mutate_manager unavailable-global \
  "if (scope.kind === 'unavailable') return false" \
  "if (scope.kind === 'unavailable') return (await this.getAccessible(client)) === 'all'" \
  "authorizes squad-less agent subscriptions"
mutate_manager squad-agent-orphan-fallback \
  "if (client.identity.type === 'agent' && !client.identity.userId) return false" \
  "if (false) return false" \
  "denies a squad-bound agent identity from an unowned"
mutate_manager skip-current-resolution \
  "? await this.resolveAgentBroadcastScope(topic, event, data)" \
  "? null" \
  "ignores stale payload squad after an agent becomes private"
mutate_manager skip-collection-resolution \
  "else if (topic === 'agents' && typeof payload.agentId === 'string') scope = await agentTopicScope(payload.agentId)" \
  "else if (topic === 'agents' && typeof payload.agentId === 'string') scope = null" \
  "reauthorizes private agent instance and collection delivery"
mutate_manager skip-deletion-fallback \
  "if (scope?.kind !== 'unavailable' || event !== 'agent.deleted') return scope" \
  "if (scope?.kind !== 'unavailable' || true) return scope" \
  "delivers private agent deletion frames only"
mutate_manager deletion-instance-id-binding \
  "if (topic.startsWith('agents:') && payload.agentId !== topic.slice('agents:'.length)) return scope" \
  "if (false) return scope" \
  "deleted instance payload omits or mismatches"
mutate_manager unowned-deletion-permission \
  "return { kind: 'permission', permission: 'agents:read' }" \
  "return { kind: 'unavailable' }" \
  "delivers unowned deletion frames"
mutate_manager broaden-missing-as-deletion \
  "if (scope?.kind !== 'unavailable' || event !== 'agent.deleted') return scope" \
  "if (scope?.kind !== 'unavailable' || event === 'agent.deleted') return scope" \
  "broadcasts global events but fails closed for missing"
mutate_manager skip-system-manager-owner \
  "scope = { kind: 'owner', ownerUserId: payload.sandboxId.slice('system_manager_'.length) }" \
  "scope = null" \
  "authorizes system-manager sandbox status only"
mutate_manager inbox-owner-before-global \
  "  private async canAccessTopicScope(client: Client, scope: TopicScope): Promise<boolean> {" \
  $'  private async canAccessTopicScope(client: Client, scope: TopicScope): Promise<boolean> {\n    if (scope.kind === '\''recipient'\'') return this.canAccessInboxRecipient(scope.recipientId, client)' \
  "preserves merge-base legacy access to foreign inbox"

cp "$TMP/lifecycle.ts" "$LIFECYCLE"
OLD="ownerUserId: agent.ownerUserId" NEW="ownerUserId: null" FILE="$LIFECYCLE" python3 - <<'PY'
import os
p=os.environ['FILE']; s=open(p).read(); old=os.environ['OLD']; new=os.environ['NEW']
if s.count(old) != 1: raise SystemExit(f'lifecycle mutation seam count was {s.count(old)}, expected 1')
open(p, 'w').write(s.replace(old, new))
PY
set +e
(cd "$CORE" && bun test src/services/agent/lifecycle.test.ts) >/dev/null 2>&1
status=$?
set -e
if [[ $status -eq 0 ]]; then echo 'SURVIVED: deletion-owner-payload'; exit 1; fi
echo 'KILLED: deletion-owner-payload'

echo 'All squad-less agent WebSocket authorization mutations were killed.'
