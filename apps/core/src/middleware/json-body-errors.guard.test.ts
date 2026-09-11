import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

interface Finding {
  file: string
  line: number
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression
  }
  return expression
}

export function findJsonPromiseCatches(source: string, file = 'fixture.ts'): Finding[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const findings: Finding[] = []

  function isRequestJsonCall(expression: ts.Expression): boolean {
    expression = unwrap(expression)
    if (!ts.isCallExpression(expression)) return false
    const callee = unwrap(expression.expression)
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'json') return false
    const req = unwrap(callee.expression)
    return (
      ts.isPropertyAccessExpression(req) &&
      req.name.text === 'req' &&
      ts.isIdentifier(unwrap(req.expression)) &&
      (unwrap(req.expression) as ts.Identifier).text === 'c'
    )
  }

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression)
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'catch' &&
        isRequestJsonCall(callee.expression)
      ) {
        findings.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return findings
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
}

describe('JSON parser bypass guard', () => {
  test('detects single-line and multiline direct promise catches', () => {
    const fixture = `
const one = await c.req.json().catch(() => ({}))
const two = await c.req
  .json<TokenVerifyBody>()
  .catch(() => ({}))
const three = await c.req
  .json<{ code?: string }>()
  .catch(() => null)
`
    expect(findJsonPromiseCatches(fixture).map(({ line }) => line)).toEqual([2, 3, 6])
  })

  test('allows direct parsing and unrelated catches', () => {
    const fixture = `
await c.req.json()
await service.json().catch(() => null)
await c.req.text().catch(() => '')
`
    expect(findJsonPromiseCatches(fixture)).toEqual([])
  })

  test('production routes do not swallow direct parser failures', () => {
    const routes = join(import.meta.dir, '..', 'routes')
    const findings = sourceFiles(routes).flatMap((path) =>
      findJsonPromiseCatches(readFileSync(path, 'utf8'), relative(routes, path))
    )
    expect(findings).toEqual([])
  })
})
