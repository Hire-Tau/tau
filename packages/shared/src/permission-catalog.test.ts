import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { PERMISSION_CATALOG, PERMISSION_DESCRIPTIONS } from './permission-catalog'
import { isGrantablePermission, Permissions } from './permissions'

const root = join(dirname(import.meta.path), '../../..')
const catalog = new Set<string>(Object.values(Permissions))

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : /\.tsx?$/.test(path) && !/\.test\./.test(path) ? [path] : []
  })
}

// Qualified integration/secret grants are checked dynamically by provider/group.
function cataloged(permission: string): boolean {
  if (catalog.has(permission)) return true
  const parts = permission.split(':')
  return (
    ['integrations', 'secrets'].includes(parts[0]!) && parts.length === 3 && catalog.has(parts.slice(0, 2).join(':'))
  )
}

test('every catalog permission has help text and every selectable entry is grantable', () => {
  expect(Object.keys(PERMISSION_DESCRIPTIONS).sort()).toEqual([...catalog].sort())
  expect(new Set(PERMISSION_CATALOG.map((entry) => entry.permission)).size).toBe(catalog.size - 1)
  for (const entry of PERMISSION_CATALOG) {
    expect(entry.description.trim()).not.toBe('')
    expect(isGrantablePermission(entry.permission)).toBe(true)
  }
  for (const retired of [
    'squads:write',
    'schedules:write',
    'ai:read',
    'ai:write',
    'actions:write',
    'channels:respond',
    'system:worker-status',
  ]) {
    expect(catalog.has(retired)).toBe(false)
    expect(isGrantablePermission(retired)).toBe(false)
  }
})

test('literal backend authorization checks and bundled role grants are covered by the catalog', () => {
  const missing: string[] = []
  const argumentIndexes: Record<string, number[]> = {
    requirePermission: [0],
    requireAnyPermission: [0, 1, 2, 3],
    requireSquadPermission: [0],
    requireAnySquadPermission: [0],
    requireAnySquadCleanupPermission: [0],
    requireEntityPermission: [0],
    requireAgentResourcePermission: [0],
    hasPermission: [1],
    hasAnyPermission: [1],
    hasUserPermission: [1],
    hasAgentResourcePermission: [2],
    resolvePermissionSquadScope: [1],
    hasUserPermissionWithExecutor: [2],
    authorize: [1],
    requireBodySchedulePermission: [1],
    canAccessWorkflow: [1],
    authorizeWorkflow: [1],
  }
  for (const path of files(join(root, 'apps/core/src'))) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const check = (node: ts.Node) => {
      if (ts.isStringLiteral(node) && node.text.includes(':') && !cataloged(node.text)) {
        missing.push(`${path.slice(root.length + 1)}: ${node.text}`)
      } else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(check)
    }
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        for (const index of argumentIndexes[node.expression.text] ?? []) {
          const arg = node.arguments[index]
          if (arg) check(arg)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  const roles = readFileSync(join(root, 'config/roles/defaults.yaml'), 'utf8')
  for (const [, grant] of roles.matchAll(/^\s*- ([a-z][a-z-]*:[a-z*: -]+)\s*(?:#.*)?$/gm)) {
    const permission = grant!.trim()
    if (!isGrantablePermission(permission)) missing.push(`config/roles/defaults.yaml: ${permission}`)
  }
  expect(missing).toEqual([])
})
