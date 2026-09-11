import ts from 'typescript'

export type DomDiagnosticCode = 'DOM001' | 'DOM002' | 'DOM003' | 'DOM004' | 'DOM005'
export type DomDiagnostic = { code: DomDiagnosticCode; path: string; line: number; message: string }
export type DomScan = { scannedFiles: number; diagnostics: DomDiagnostic[] }

const hooks = new Set(['test', 'it', 'describe', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll'])
const domNames = new Set(['window', 'document', 'navigator', 'location', 'Event', 'EventTarget'])
const infrastructure = new Set([
  'test/domGlobalOwnershipGuard.ts',
  'test/domGlobalOwnershipGuard.test.ts',
  'test/domHarness.ts',
  'test/domHarness.test.tsx',
])
const unwrap = (e: ts.Expression): ts.Expression => {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression
  return e
}
const member = (e: ts.Expression) => {
  e = unwrap(e)
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  if (ts.isElementAccessExpression(e) && e.argumentExpression) {
    const a = unwrap(e.argumentExpression)
    if (ts.isStringLiteralLike(a) || ts.isNumericLiteral(a)) return a.text
  }
}

type Kind =
  | 'window'
  | 'happy'
  | 'bun'
  | 'harnessNs'
  | 'harness'
  | 'global'
  | 'object'
  | 'defineProperty'
  | 'defineProperties'
  | 'assign'
  | `hook:${string}`
  | 'local'
  | 'unknown'
type Env = Map<string, Kind>

/** Scans executable test code for process-global DOM ownership outside domHarness. */
export function scanDomGlobalOwnership(source: string, path: string): DomDiagnostic[] {
  const sf = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const root: Env = new Map([
    ['globalThis', 'global'],
    ['Object', 'object'],
  ])
  const fns = new Map<string, ts.FunctionLikeDeclaration>()
  const out: DomDiagnostic[] = []
  const rawReport = (code: DomDiagnosticCode, n: ts.Node, message: string) =>
    out.push({ code, path, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, message })
  let mutationCovered = false
  let ownerUnsafe = false
  const report = (code: DomDiagnosticCode, n: ts.Node, message: string) => {
    if (code === 'DOM002') {
      if (mutationCovered) return
      ownerUnsafe = true
    }
    rawReport(code, n, message)
  }
  const kind = (x: ts.Expression, env: Env): Kind => {
    x = unwrap(x)
    if (ts.isIdentifier(x)) return env.get(x.text) ?? root.get(x.text) ?? 'unknown'
    if (
      ts.isObjectLiteralExpression(x) ||
      ts.isArrayLiteralExpression(x) ||
      ts.isFunctionExpression(x) ||
      ts.isArrowFunction(x)
    )
      return 'local'
    if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) {
      const base = kind(x.expression, env),
        name = member(x)
      if (base === 'object' && (name === 'defineProperty' || name === 'defineProperties' || name === 'assign'))
        return name
      if (base === 'happy' && name === 'Window') return 'window'
      if (base === 'harnessNs' && name === 'acquireDomHarness') return 'harness'
      if (base === 'bun' && name && hooks.has(name)) return `hook:${name}`
    }
    return 'unknown'
  }
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
      const mod = s.moduleSpecifier.text,
        b = s.importClause?.namedBindings
      if (b && ts.isNamespaceImport(b))
        root.set(
          b.name.text,
          mod === 'happy-dom'
            ? 'happy'
            : mod === 'bun:test'
              ? 'bun'
              : mod.endsWith('domHarness')
                ? 'harnessNs'
                : 'unknown'
        )
      if (b && ts.isNamedImports(b))
        for (const e of b.elements) {
          const original = (e.propertyName ?? e.name).text
          if (mod === 'happy-dom' && original === 'Window') root.set(e.name.text, 'window')
          if (mod.endsWith('domHarness') && original === 'acquireDomHarness') root.set(e.name.text, 'harness')
          if (mod === 'bun:test' && hooks.has(original)) root.set(e.name.text, `hook:${original}`)
        }
    }
    if (ts.isFunctionDeclaration(s) && s.name) fns.set(s.name.text, s)
    if (ts.isVariableStatement(s))
      for (const d of s.declarationList.declarations)
        if (d.initializer) {
          if (ts.isIdentifier(d.name)) {
            const u = unwrap(d.initializer)
            if (ts.isArrowFunction(u) || ts.isFunctionExpression(u)) fns.set(d.name.text, u)
            else root.set(d.name.text, kind(u, root))
          } else if (ts.isObjectBindingPattern(d.name)) {
            const k = kind(d.initializer, root)
            for (const e of d.name.elements)
              if (ts.isIdentifier(e.name)) {
                const n =
                  e.propertyName && (ts.isIdentifier(e.propertyName) || ts.isStringLiteralLike(e.propertyName))
                    ? e.propertyName.text
                    : e.name.text
                if (k === 'object' && ['defineProperty', 'defineProperties', 'assign'].includes(n))
                  root.set(e.name.text, n as Kind)
                else if (k === 'happy' && n === 'Window') root.set(e.name.text, 'window')
                else if (k === 'harnessNs' && n === 'acquireDomHarness') root.set(e.name.text, 'harness')
                else if (k === 'bun' && hooks.has(n)) root.set(e.name.text, `hook:${n}`)
              }
          }
        }
  }
  // `kind` resolves namespace members through the active lexical environment,
  // so a local shadow cannot inherit the meaning of an imported namespace.
  const value = (e: ts.Expression, env: Env): Kind => kind(e, env)
  const awaitedHarnessLease = (n: ts.Node, env: Env): string | undefined => {
    if (!ts.isVariableDeclaration(n) && !ts.isBinaryExpression(n)) return
    const name = ts.isVariableDeclaration(n) ? n.name : n.left
    const initializer = ts.isVariableDeclaration(n) ? n.initializer : n.right
    if (!ts.isIdentifier(name) || !initializer) return
    const expression = unwrap(initializer)
    if (!ts.isAwaitExpression(expression)) return
    const call = unwrap(expression.expression)
    if (ts.isCallExpression(call) && value(call.expression, env) === 'harness') return name.text
  }
  const awaitedCleanup = (n: ts.Node, lease: string): boolean => {
    if (!ts.isBlock(n)) return false
    return n.statements.some((statement) => {
      if (!ts.isExpressionStatement(statement)) return false
      const outer = unwrap(statement.expression)
      if (!ts.isAwaitExpression(outer)) return false
      const expression = unwrap(outer.expression)
      if (!ts.isCallExpression(expression)) return false
      const callee = unwrap(expression.expression)
      if (
        !(ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) ||
        member(callee) !== 'cleanup'
      )
        return false
      const receiver = unwrap(callee.expression)
      return ts.isIdentifier(receiver) && receiver.text === lease
    })
  }
  const acquisitions = (fn: ts.FunctionLikeDeclaration, env: Env) => {
    const found = new Map<string, number>()
    if (!fn.body || !ts.isBlock(fn.body)) return found
    for (const statement of fn.body.statements) {
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations) {
          const lease = awaitedHarnessLease(declaration, env)
          if (lease) found.set(lease, declaration.getStart(sf))
        }
      if (ts.isExpressionStatement(statement)) {
        const expression = unwrap(statement.expression)
        if (ts.isBinaryExpression(expression)) {
          const lease = awaitedHarnessLease(expression, env)
          if (lease) found.set(lease, expression.getStart(sf))
        }
      }
    }
    return found
  }
  const coveredLocally = (node: ts.Node, fn: ts.FunctionLikeDeclaration, env: Env) => {
    const leases = acquisitions(fn, env)
    for (let parent = node.parent; parent && parent !== fn; parent = parent.parent) {
      if (!ts.isTryStatement(parent) || !parent.finallyBlock) continue
      if (node.getStart(sf) < parent.tryBlock.getStart(sf) || node.end > parent.tryBlock.end) continue
      for (const [lease, position] of leases)
        if (position < node.getStart(sf) && awaitedCleanup(parent.finallyBlock, lease)) return true
    }
    return false
  }
  const active = new Set<number>()
  const analyze = (
    fn: ts.FunctionLikeDeclaration,
    inherited = root,
    args: readonly Kind[] = [],
    coveredByCaller = false
  ) => {
    if (active.has(fn.pos)) return
    active.add(fn.pos)
    const env = new Map(inherited)
    const bindParameter = (name: ts.BindingName, argument: Kind) => {
      if (ts.isIdentifier(name)) {
        env.set(name.text, argument)
        return
      }
      if (ts.isObjectBindingPattern(name))
        for (const element of name.elements)
          if (ts.isIdentifier(element.name)) {
            const property =
              element.propertyName &&
              (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName))
                ? element.propertyName.text
                : element.name.text
            const resolved =
              argument === 'happy' && property === 'Window'
                ? 'window'
                : argument === 'harnessNs' && property === 'acquireDomHarness'
                  ? 'harness'
                  : argument === 'bun' && hooks.has(property)
                    ? (`hook:${property}` as Kind)
                    : 'unknown'
            env.set(element.name.text, resolved)
          }
    }
    fn.parameters.forEach((p, i) => bindParameter(p.name, args[i] ?? 'local'))
    const localFns = new Map<string, ts.FunctionLikeDeclaration>()
    if (fn.body && ts.isBlock(fn.body))
      for (const statement of fn.body.statements)
        if (ts.isFunctionDeclaration(statement) && statement.name) localFns.set(statement.name.text, statement)
    const declarations = (n: ts.Node) => {
      if (n !== fn.body && (ts.isBlock(n) || ts.isFunctionLike(n))) return
      if (ts.isVariableDeclaration(n)) {
        const expression = n.initializer && unwrap(n.initializer)
        if (
          ts.isIdentifier(n.name) &&
          expression &&
          (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
        )
          localFns.set(n.name.text, expression)
        const initializer = n.initializer ? value(n.initializer, env) : 'local'
        if (ts.isIdentifier(n.name)) env.set(n.name.text, initializer)
        else if (ts.isObjectBindingPattern(n.name))
          for (const element of n.name.elements)
            if (ts.isIdentifier(element.name)) {
              const name =
                element.propertyName &&
                (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName))
                  ? element.propertyName.text
                  : element.name.text
              const resolved =
                initializer === 'happy' && name === 'Window'
                  ? 'window'
                  : initializer === 'harnessNs' && name === 'acquireDomHarness'
                    ? 'harness'
                    : initializer === 'bun' && hooks.has(name)
                      ? (`hook:${name}` as Kind)
                      : initializer === 'object' && ['defineProperty', 'defineProperties', 'assign'].includes(name)
                        ? (name as Kind)
                        : 'unknown'
              env.set(element.name.text, resolved)
            }
      }
      ts.forEachChild(n, declarations)
    }
    if (fn.body) declarations(fn.body)
    const visit = (n: ts.Node) => {
      if (n !== fn.body && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n))) return
      if (n !== fn.body && ts.isBlock(n)) {
        const wrapper = ts.factory.createArrowFunction(undefined, undefined, [], undefined, undefined, n)
        ts.setTextRange(wrapper, n)
        analyze(wrapper, env, [], coveredByCaller || coveredLocally(n, fn, env))
        return
      }
      mutationCovered = coveredByCaller || coveredLocally(n, fn, env)
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unwrap(n.left))
      )
        env.set((unwrap(n.left) as ts.Identifier).text, value(n.right, env))
      if (ts.isNewExpression(n) && value(n.expression, env) === 'window')
        report('DOM001', n, 'constructs happy-dom Window outside the DOM harness')
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const l = unwrap(n.left)
        if (
          (ts.isPropertyAccessExpression(l) || ts.isElementAccessExpression(l)) &&
          value(l.expression, env) === 'global'
        ) {
          const p = member(l)
          if (!p || domNames.has(p)) report('DOM002', n, `writes DOM global ${p ?? '<dynamic>'}`)
        }
      }
      if (ts.isDeleteExpression(n)) {
        const e = unwrap(n.expression)
        if (
          (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) &&
          value(e.expression, env) === 'global'
        ) {
          const p = member(e)
          if (!p || domNames.has(p)) report('DOM002', n, `deletes DOM global ${p ?? '<dynamic>'}`)
        }
      }
      if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
        const e = unwrap(n.operand)
        if (
          (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) &&
          (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) &&
          value(e.expression, env) === 'global'
        ) {
          const p = member(e)
          if (!p || domNames.has(p)) report('DOM002', n, `updates DOM global ${p ?? '<dynamic>'}`)
        }
      }
      if (ts.isCallExpression(n)) {
        const k = value(n.expression, env)
        if (k === 'defineProperty' || k === 'defineProperties' || k === 'assign') {
          const target = n.arguments[0] && value(n.arguments[0], env)
          if (target === 'global') {
            let unsafe = false
            if (k === 'defineProperty') {
              const key = n.arguments[1] && unwrap(n.arguments[1])
              unsafe = !key || !ts.isStringLiteralLike(key) || domNames.has(key.text)
            } else {
              const objects = k === 'assign' ? n.arguments.slice(1) : n.arguments.slice(1, 2)
              for (const object of objects) {
                const o = unwrap(object)
                if (!ts.isObjectLiteralExpression(o)) unsafe = true
                else
                  for (const p of o.properties) {
                    const name =
                      p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : undefined
                    if (!name || domNames.has(name)) unsafe = true
                  }
              }
            }
            if (unsafe) report('DOM002', n, `${k} mutates DOM globals`)
          }
        }
        if (typeof k === 'string' && (k === 'hook:test' || k === 'hook:it')) {
          const callback = n.arguments[1] && unwrap(n.arguments[1])
          if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)))
            analyze(callback, env, [], coveredByCaller || coveredLocally(n, fn, env))
          else if (callback && ts.isIdentifier(callback) && fns.has(callback.text))
            analyze(fns.get(callback.text)!, env, [], coveredByCaller || coveredLocally(n, fn, env))
        }
        if (ts.isIdentifier(n.expression)) {
          const local = localFns.get(n.expression.text)
          const called = local ?? (!env.has(n.expression.text) ? fns.get(n.expression.text) : undefined)
          if (called)
            analyze(
              called,
              env,
              n.arguments.map((a) => value(a, env)),
              coveredByCaller || coveredLocally(n, fn, env)
            )
        }
      }
      ts.forEachChild(n, visit)
    }
    if (fn.body) visit(fn.body)
    active.delete(fn.pos)
  }
  const callbackOf = (call: ts.CallExpression, hook: string): ts.FunctionLikeDeclaration | undefined => {
    const argument = call.arguments[hook === 'test' || hook === 'it' || hook === 'describe' ? 1 : 0]
    if (!argument) return
    const unwrapped = unwrap(argument)
    if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) return unwrapped
    if (ts.isIdentifier(unwrapped)) return fns.get(unwrapped.text)
  }
  const beforeEachLeases = new Set<string>(),
    beforeAllLeases = new Set<string>(),
    afterEachLeases = new Set<string>(),
    afterAllLeases = new Set<string>()
  for (const statement of sf.statements)
    if (ts.isExpressionStatement(statement)) {
      const expression = unwrap(statement.expression)
      if (!ts.isCallExpression(expression)) continue
      const binding = value(expression.expression, root)
      if (
        binding !== 'hook:beforeEach' &&
        binding !== 'hook:beforeAll' &&
        binding !== 'hook:afterEach' &&
        binding !== 'hook:afterAll'
      )
        continue
      const callback = callbackOf(expression, binding.slice(5))
      if (!callback?.body) continue
      if (binding === 'hook:beforeEach')
        for (const lease of acquisitions(callback, root).keys()) beforeEachLeases.add(lease)
      if (binding === 'hook:beforeAll')
        for (const lease of acquisitions(callback, root).keys()) beforeAllLeases.add(lease)
      if (binding === 'hook:afterEach')
        for (const lease of beforeEachLeases) if (awaitedCleanup(callback.body, lease)) afterEachLeases.add(lease)
      if (binding === 'hook:afterAll')
        for (const lease of beforeAllLeases) if (awaitedCleanup(callback.body, lease)) afterAllLeases.add(lease)
    }
  const hookProtected =
    [...beforeEachLeases].some((lease) => afterEachLeases.has(lease)) ||
    [...beforeAllLeases].some((lease) => afterAllLeases.has(lease))
  const runOwner = (fn: ts.FunctionLikeDeclaration, protectedByHooks = false, inherited = root) => {
    ownerUnsafe = false
    analyze(fn, inherited, [], protectedByHooks)
    if (ownerUnsafe)
      rawReport('DOM003', fn, 'DOM ownership requires awaited acquireDomHarness and matching awaited cleanup')
  }
  const runExpression = (expression: ts.Expression, range: ts.Node, env: Env) => {
    const wrapper = ts.factory.createArrowFunction(undefined, undefined, [], undefined, undefined, expression)
    ts.setTextRange(wrapper, range)
    runOwner(wrapper, false, env)
  }
  const hooksProtectRegion = (statements: readonly ts.Statement[]) => {
    const acquiredEach = new Set<string>(),
      acquiredAll = new Set<string>(),
      cleanedEach = new Set<string>(),
      cleanedAll = new Set<string>()
    for (const statement of statements)
      if (ts.isExpressionStatement(statement)) {
        const expression = unwrap(statement.expression)
        if (!ts.isCallExpression(expression)) continue
        const kind = value(expression.expression, root)
        if (typeof kind !== 'string' || !kind.startsWith('hook:')) continue
        const hook = kind.slice(5),
          callback = callbackOf(expression, hook)
        if (!callback?.body) continue
        if (hook === 'beforeEach') for (const lease of acquisitions(callback, root).keys()) acquiredEach.add(lease)
        if (hook === 'beforeAll') for (const lease of acquisitions(callback, root).keys()) acquiredAll.add(lease)
        if (hook === 'afterEach')
          for (const lease of acquiredEach) if (awaitedCleanup(callback.body, lease)) cleanedEach.add(lease)
        if (hook === 'afterAll')
          for (const lease of acquiredAll) if (awaitedCleanup(callback.body, lease)) cleanedAll.add(lease)
      }
    return (
      [...acquiredEach].some((lease) => cleanedEach.has(lease)) ||
      [...acquiredAll].some((lease) => cleanedAll.has(lease))
    )
  }
  const processStatements = (statements: readonly ts.Statement[], inherited: Env = root) => {
    const scope: Env = new Map(inherited)
    const regionProtected = hooksProtectRegion(statements)
    for (const statement of statements) {
      if (ts.isImportDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isExportDeclaration(statement))
        continue
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations)
          if (declaration.initializer) {
            const initializer = unwrap(declaration.initializer)
            const resolved = value(initializer, scope)
            const functionInitializer = ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
            if (ts.isIdentifier(declaration.name) && !functionInitializer) scope.set(declaration.name.text, resolved)
            else if (ts.isObjectBindingPattern(declaration.name))
              for (const element of declaration.name.elements)
                if (ts.isIdentifier(element.name)) {
                  const name =
                    element.propertyName &&
                    (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName))
                      ? element.propertyName.text
                      : element.name.text
                  if (resolved === 'bun' && hooks.has(name)) scope.set(element.name.text, `hook:${name}`)
                }
            if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer))
              runExpression(initializer, declaration, scope)
          }
        continue
      }
      if (ts.isExpressionStatement(statement)) {
        const expression = unwrap(statement.expression)
        if (
          ts.isBinaryExpression(expression) &&
          expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(unwrap(expression.left))
        )
          scope.set((unwrap(expression.left) as ts.Identifier).text, value(expression.right, scope))
        if (ts.isCallExpression(expression)) {
          const kind = value(expression.expression, scope)
          if (typeof kind === 'string' && kind.startsWith('hook:')) {
            const hook = kind.slice(5),
              callback = callbackOf(expression, hook)
            if (hook === 'describe') {
              if (callback?.body && ts.isBlock(callback.body)) processStatements(callback.body.statements, scope)
              continue
            }
            if (callback)
              runOwner(callback, hook === 'test' || hook === 'it' ? regionProtected || hookProtected : false, scope)
            continue
          }
        }
        runExpression(expression, statement, scope)
        continue
      }
      const block = ts.factory.createBlock([statement], true)
      ts.setTextRange(block, statement)
      const wrapper = ts.factory.createArrowFunction(undefined, undefined, [], undefined, undefined, block)
      ts.setTextRange(wrapper, statement)
      runOwner(wrapper, false, scope)
    }
  }
  processStatements(sf.statements)

  return out
}

export function validateDomOwnershipDiscovery(scan: DomScan, waivers: readonly string[] = []): DomDiagnostic[] {
  const waiverSet = new Set(waivers)
  const result = scan.diagnostics.filter((d) => !waiverSet.has(d.path))
  if (scan.scannedFiles === 0)
    result.push({ code: 'DOM004', path: '<discovery>', line: 1, message: 'test discovery scanned zero files' })
  const violated = new Set(scan.diagnostics.map((d) => d.path))
  for (const w of waivers)
    if (!violated.has(w)) result.push({ code: 'DOM005', path: w, line: 1, message: 'stale DOM ownership waiver' })
  return result
}

export function isDomOwnershipInfrastructure(path: string): boolean {
  return infrastructure.has(path.replace(/^.*?src\//, ''))
}
