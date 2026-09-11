import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { DOM_GLOBAL_NAMES } from './domHarness'

type Violation = { path: string; global: string; operation: string }
type Scan = { scannedFiles: number; violations: Violation[] }
type Value =
  | 'beforeAll'
  | 'bunNamespace'
  | 'globalThis'
  | 'object'
  | 'reflect'
  | 'defineProperty'
  | 'assign'
  | 'local'
  | 'unknown'
  | `literal:${string}`

const domGlobals = new Set<string>(DOM_GLOBAL_NAMES)
const unwrap = (node: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(node)) node = node.expression
  return node
}
const propertyName = (node: ts.Expression): string | undefined => {
  node = unwrap(node)
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const argument = unwrap(node.argumentExpression)
    return ts.isStringLiteralLike(argument) ? argument.text : undefined
  }
}

/** Finds process-global DOM writes reachable from a file-lifetime beforeAll hook. */
export function findPersistentDomMutations(source: string, path: string): Violation[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const values = new Map<string, Value>([
    ['globalThis', 'globalThis'],
    ['Object', 'object'],
    ['Reflect', 'reflect'],
  ])
  const functions = new Map<string, ts.FunctionLikeDeclaration>()

  const valueOf = (expression: ts.Expression, locals = new Map<string, Value>()): Value => {
    expression = unwrap(expression)
    if (ts.isIdentifier(expression)) return locals.get(expression.text) ?? values.get(expression.text) ?? 'unknown'
    if (ts.isStringLiteralLike(expression)) return `literal:${expression.text}`
    const name = propertyName(expression)
    if (name && (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))) {
      const object = valueOf(expression.expression, locals)
      if (object === 'bunNamespace' && name === 'beforeAll') return 'beforeAll'
      if ((object === 'object' || object === 'reflect') && name === 'defineProperty') return 'defineProperty'
      if (object === 'object' && name === 'assign') return 'assign'
    }
    if (
      ts.isObjectLiteralExpression(expression) ||
      ts.isArrayLiteralExpression(expression) ||
      ts.isFunctionExpression(expression) ||
      ts.isArrowFunction(expression)
    )
      return 'local'
    return 'unknown'
  }

  const bindingName = (element: ts.BindingElement) => {
    const name = element.propertyName ?? element.name
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
    if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(unwrap(name.expression)))
      return (unwrap(name.expression) as ts.StringLiteralLike).text
  }

  const collect = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'bun:test'
    ) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) values.set(bindings.name.text, 'bunNamespace')
      if (bindings && ts.isNamedImports(bindings))
        for (const item of bindings.elements)
          if ((item.propertyName ?? item.name).text === 'beforeAll') values.set(item.name.text, 'beforeAll')
    }
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node)
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        const value = valueOf(node.initializer)
        values.set(node.name.text, value)
        const init = unwrap(node.initializer)
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) functions.set(node.name.text, init)
        if (ts.isIdentifier(init) && functions.has(init.text)) functions.set(node.name.text, functions.get(init.text)!)
      } else if (ts.isObjectBindingPattern(node.name)) {
        const objectValue = valueOf(node.initializer)
        for (const item of node.name.elements) {
          if (!ts.isIdentifier(item.name)) continue
          const name = bindingName(item)
          if (objectValue === 'bunNamespace' && name === 'beforeAll') values.set(item.name.text, 'beforeAll')
          if ((objectValue === 'object' || objectValue === 'reflect') && name === 'defineProperty')
            values.set(item.name.text, 'defineProperty')
          if (objectValue === 'object' && name === 'assign') values.set(item.name.text, 'assign')
        }
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(file)

  const violations: Violation[] = []
  const report = (global: string, operation: string) => violations.push({ path, global, operation })
  const analyzeFunction = (
    fn: ts.FunctionLikeDeclaration,
    argumentValues: readonly Value[] = [],
    seen = new Set<string>()
  ) => {
    const contextKey = `${fn.pos}:${fn.end}:${argumentValues.join(',')}`
    if (seen.has(contextKey)) return
    seen.add(contextKey)
    const locals = new Map<string, Value>()
    fn.parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) locals.set(parameter.name.text, argumentValues[index] ?? 'unknown')
    })
    const visit = (node: ts.Node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const left = unwrap(node.left)
        if (
          (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) &&
          valueOf(left.expression, locals) === 'globalThis'
        ) {
          const name = propertyName(left)
          if (!name || domGlobals.has(name)) report(name ?? '<dynamic>', 'assignment')
        }
      }
      if (ts.isDeleteExpression(node)) {
        const expression = unwrap(node.expression)
        if (
          (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
          valueOf(expression.expression, locals) === 'globalThis'
        ) {
          const name = propertyName(expression)
          if (!name || domGlobals.has(name)) report(name ?? '<dynamic>', 'delete')
        }
      }
      if (ts.isCallExpression(node)) {
        const calleeValue = valueOf(node.expression, locals)
        if (calleeValue === 'defineProperty') {
          const target = node.arguments[0] ? valueOf(node.arguments[0], locals) : 'unknown'
          if (target !== 'local') {
            const propertyValue = node.arguments[1] ? valueOf(node.arguments[1], locals) : 'unknown'
            const property = propertyValue.startsWith('literal:') ? propertyValue.slice('literal:'.length) : undefined
            if (target === 'unknown' || !property || domGlobals.has(property))
              report(target === 'unknown' || !property ? '<dynamic>' : property, 'defineProperty')
          }
        } else if (calleeValue === 'assign') {
          const target = node.arguments[0] ? valueOf(node.arguments[0], locals) : 'unknown'
          if (target === 'unknown') report('<dynamic>', 'assign')
          if (target === 'globalThis')
            for (const source of node.arguments.slice(1)) {
              if (!ts.isObjectLiteralExpression(unwrap(source))) report('<dynamic>', 'assign')
              else
                for (const property of (unwrap(source) as ts.ObjectLiteralExpression).properties) {
                  const name =
                    property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
                      ? property.name.text
                      : undefined
                  if (!name || domGlobals.has(name)) report(name ?? '<dynamic>', 'assign')
                }
            }
        } else if (ts.isIdentifier(node.expression) && functions.has(node.expression.text)) {
          analyzeFunction(
            functions.get(node.expression.text)!,
            node.arguments.map((argument) => valueOf(argument, locals)),
            seen
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    if (fn.body) visit(fn.body)
  }

  const findHooks = (node: ts.Node) => {
    if (ts.isCallExpression(node) && valueOf(node.expression) === 'beforeAll') {
      const callback = node.arguments[0] && unwrap(node.arguments[0])
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) analyzeFunction(callback)
      else if (callback && ts.isIdentifier(callback) && functions.has(callback.text))
        analyzeFunction(functions.get(callback.text)!)
      else report('<dynamic>', 'beforeAll callback')
    }
    ts.forEachChild(node, findHooks)
  }
  findHooks(file)
  return violations
}

export function validatePersistentDomMutationScan(scan: Scan): string[] {
  return scan.scannedFiles === 0 ? ['scanned zero test files'] : []
}

function persistentDomMutationScan(): Scan {
  const glob = new Bun.Glob('**/*.{test,spec}.{ts,tsx}')
  const files = [...glob.scanSync({ cwd: new URL('../', import.meta.url).pathname, onlyFiles: true })].sort()
  // This is a small static-source audit. Read and parse one file at a time,
  // without queueing the entire inventory on the shared async I/O pool.
  const violations = files.flatMap((path) =>
    findPersistentDomMutations(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), path)
  )
  return { scannedFiles: files.length, violations }
}

const PR987_DOM_OWNER_FILES = [
  'lib/serviceWorker.test.ts',
  'providers/AuthProvider.test.tsx',
  'components/settings/OAuthFlow.test.tsx',
  'components/settings/InviteRolePicker.test.tsx',
  'components/settings/NumberSetting.test.tsx',
  'components/settings/ChannelsSection.test.tsx',
] as const

export function findPr987DomOwnershipViolations(source: string, path: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const acquireImports = new Set<string>()
  const windowImports = new Set<string>()
  const globalAliases = new Set(['globalThis'])
  const objectAliases = new Set(['Object'])
  const objectMethods = new Map<string, 'assign' | 'defineProperty'>()

  const importedName = (element: ts.ImportSpecifier) => (element.propertyName ?? element.name).text
  const collectBindings = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (node.moduleSpecifier.text.endsWith('/test/domHarness') && importedName(element) === 'acquireDomHarness')
            acquireImports.add(element.name.text)
          if (node.moduleSpecifier.text === 'happy-dom' && importedName(element) === 'Window')
            windowImports.add(element.name.text)
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer)
      if (ts.isIdentifier(initializer) && globalAliases.has(initializer.text)) globalAliases.add(node.name.text)
      if (ts.isIdentifier(initializer) && objectAliases.has(initializer.text)) objectAliases.add(node.name.text)
      const method = propertyName(initializer)
      if (
        method &&
        (method === 'assign' || method === 'defineProperty') &&
        (ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer)) &&
        ts.isIdentifier(initializer.expression) &&
        objectAliases.has(initializer.expression.text)
      )
        objectMethods.set(node.name.text, method)
    }
    ts.forEachChild(node, collectBindings)
  }
  collectBindings(file)

  const violations: string[] = []
  const acquiredLeases = new Set<string>()
  let cleaned = false
  const inspectHook = (node: ts.Node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return
    const hook = node.expression.text
    if (hook !== 'beforeEach' && hook !== 'afterEach') return
    const callback = node.arguments[0] && unwrap(node.arguments[0])
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return
    const shadowed = new Set<string>()
    callback.parameters.forEach((parameter) => {
      if (ts.isIdentifier(parameter.name)) shadowed.add(parameter.name.text)
    })
    const visit = (child: ts.Node) => {
      if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name)) shadowed.add(child.name.text)
      if (ts.isAwaitExpression(child) && ts.isCallExpression(unwrap(child.expression))) {
        const call = unwrap(child.expression) as ts.CallExpression
        if (
          hook === 'beforeEach' &&
          ts.isIdentifier(call.expression) &&
          acquireImports.has(call.expression.text) &&
          !shadowed.has(call.expression.text)
        ) {
          const parent = child.parent
          if (ts.isBinaryExpression(parent) && parent.right === child && ts.isIdentifier(parent.left))
            acquiredLeases.add(parent.left.text)
          if (ts.isVariableDeclaration(parent) && parent.initializer === child && ts.isIdentifier(parent.name))
            acquiredLeases.add(parent.name.text)
        }
        if (
          hook === 'afterEach' &&
          (ts.isPropertyAccessExpression(call.expression) || ts.isElementAccessExpression(call.expression)) &&
          propertyName(call.expression) === 'cleanup' &&
          ts.isIdentifier(call.expression.expression) &&
          acquiredLeases.has(call.expression.expression.text)
        )
          cleaned = true
      }
      ts.forEachChild(child, visit)
    }
    if (callback.body) visit(callback.body)
  }
  const inspectOwners = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && windowImports.has(node.expression.text))
      violations.push(`${path}: constructs an ad-hoc Window`)
    if (ts.isCallExpression(node)) {
      let method: 'assign' | 'defineProperty' | undefined
      if (ts.isIdentifier(node.expression)) method = objectMethods.get(node.expression.text)
      else if (
        (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) &&
        ts.isIdentifier(node.expression.expression) &&
        objectAliases.has(node.expression.expression.text)
      ) {
        const name = propertyName(node.expression)
        if (name === 'assign' || name === 'defineProperty') method = name
      }
      const target = node.arguments[0] && unwrap(node.arguments[0])
      if (method && target && ts.isIdentifier(target) && globalAliases.has(target.text))
        violations.push(`${path}: ${method} mutates DOM globals directly`)
    }
    inspectHook(node)
    ts.forEachChild(node, inspectOwners)
  }
  inspectOwners(file)
  if (acquiredLeases.size === 0) violations.push(`${path}: missing canonical acquired DOM lease in beforeEach`)
  if (!cleaned) violations.push(`${path}: missing awaited DOM lease cleanup in afterEach`)
  return violations
}

async function findPr987AdHocDomOwners() {
  const violations: string[] = []
  for (const path of PR987_DOM_OWNER_FILES) {
    const source = await Bun.file(new URL(`../${path}`, import.meta.url)).text()
    violations.push(...findPr987DomOwnershipViolations(source, path))
  }
  return violations
}

describe('persistent DOM mutation isolation', () => {
  test('detects direct, aliased, computed, helper, and dynamic mutations', () => {
    const source = `
      import { beforeAll as setup } from 'bun:test'
      import * as bt from 'bun:test'
      const globals = globalThis
      const O = Object
      const dp = O['defineProperty']
      const { assign: copy } = O
      function install(target: object, key: PropertyKey) { dp(target, key, { value: {} }) }
      setup(() => { globals.window = {}; install(globalThis, 'navigator'); copy(globals, { document: {} }) })
      bt.beforeAll(() => dp(globals, getKey(), { value: {} }))
    `
    expect(findPersistentDomMutations(source, 'fixture.test.ts').map((item) => item.global)).toEqual([
      'window',
      'navigator',
      'document',
      '<dynamic>',
    ])
  })

  test('reanalyzes helpers when later calls receive dangerous bindings', () => {
    const source = `
      import { beforeAll } from 'bun:test'
      function install(target: object, key: PropertyKey) {
        Object.defineProperty(target, key, { value: {} })
      }
      beforeAll(() => {
        install({}, 'safe')
        install(globalThis, 'window')
      })
    `

    expect(findPersistentDomMutations(source, 'safe-first.test.ts').map((item) => item.global)).toEqual(['window'])
  })

  test('allows local objects and per-test DOM harnesses', () => {
    const source = `
      import { beforeAll, test } from 'bun:test'
      import { acquireDomHarness } from './domHarness'
      beforeAll(() => { const fixture = {}; Object.assign(fixture, { window: {} }) })
      test('isolated', async () => { const harness = await acquireDomHarness({ url: 'https://example.test' }); await harness.cleanup() })
    `
    expect(findPersistentDomMutations(source, 'safe.test.ts')).toEqual([])
  })

  test('fails closed when source discovery returns no test files', () => {
    expect(validatePersistentDomMutationScan({ scannedFiles: 0, violations: [] })).toEqual(['scanned zero test files'])
  })

  test('test files never install DOM globals from beforeAll', () => {
    const scan = persistentDomMutationScan()
    expect(scan.scannedFiles).toBeGreaterThan(0)
    expect(validatePersistentDomMutationScan(scan)).toEqual([])
    expect(scan.violations).toEqual([])
  })

  test('PR987 offender and victims use structurally verified serialized DOM ownership', async () => {
    const source = `
      import { beforeEach, afterEach } from 'bun:test'
      import { acquireDomHarness as acquire } from './domHarness'
      import { Window as HappyWindow } from 'happy-dom'
      const globals = globalThis
      const O = Object
      const dp = O.defineProperty
      async function deadCode() { await acquire({ url: 'http://localhost' }) }
      beforeEach(async (acquire) => { await acquire({ url: 'http://localhost' }); new HappyWindow() })
      afterEach(async () => { dp(globals, 'navigator', { value: {} }) })
    `
    expect(findPr987DomOwnershipViolations(source, 'fixture.test.tsx')).toEqual([
      'fixture.test.tsx: constructs an ad-hoc Window',
      'fixture.test.tsx: defineProperty mutates DOM globals directly',
      'fixture.test.tsx: missing canonical acquired DOM lease in beforeEach',
      'fixture.test.tsx: missing awaited DOM lease cleanup in afterEach',
    ])
    expect(await findPr987AdHocDomOwners()).toEqual([])
  })
})
