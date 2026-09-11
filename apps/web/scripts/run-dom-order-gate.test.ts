import { afterEach, describe, expect, test } from 'bun:test'
import {
  atomicArtifact,
  fisherYates,
  mulberry32,
  runDomOrderGate,
  validateCases,
  validateOrderResult,
  emittedFileOrder,
  type GatePrimitives,
} from './run-dom-order-gate'
import { discoverTestFiles, type TestBaseline } from './run-full-test-gate'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'

const temporaryRoots = new Set<string>()
afterEach(async () => {
  const roots = [...temporaryRoots]
  temporaryRoots.clear()
  await Promise.allSettled(roots.map((root) => rm(root, { recursive: true, force: true })))
})

const smallFiles = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts']
const smallBaseline: TestBaseline = { schemaVersion: 1, fileCount: 3, testCount: 6, skipCount: 0, files: smallFiles }
const summary = (order: string[], tests: number) =>
  `${order.map((file) => `./${file}:`).join('\n')}\n ${tests} pass\n 0 fail\nRan ${tests} tests across ${order.length} files.`
const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text))
      c.close()
    },
  })
async function harness(
  options: { broken?: boolean; signal?: boolean; resultChannel?: 'stderr' | 'stdout' | 'split' } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'dom-order-orchestration-'))
  temporaryRoots.add(root)
  const events: string[] = [],
    commands: string[][] = [],
    handlers = new Map<string, () => void>(),
    kills: string[] = []
  const baseline = JSON.parse(await readFile(join(import.meta.dir, '../test-baseline.json'), 'utf8')) as TestBaseline
  baseline.files = await discoverTestFiles()
  baseline.fileCount = baseline.files.length
  const map = (path: string) => join(root, basename(path))
  const io: GatePrimitives = {
    readFile: (p) =>
      p.endsWith('test-baseline.json') ? Promise.resolve(JSON.stringify(baseline)) : readFile(p, 'utf8'),
    mkdir: async (p) => {
      events.push(`mkdir:${basename(p)}`)
      await mkdir(root, { recursive: true })
    },
    writeFile: async (p, v) => {
      events.push(`write:${basename(p)}`)
      await writeFile(map(p), v)
    },
    rename: async (a, b) => {
      events.push(`rename:${basename(b)}`)
      await rename(map(a), map(b))
    },
    rm: async (p) => rm(map(p), { force: true }),
    spawn(command) {
      events.push(`spawn:${command.length}`)
      commands.push(command)
      const order = command.slice(2).map((x) => x.slice(2))
      if (options.signal) queueMicrotask(() => handlers.get('SIGTERM')?.())
      if (options.broken) {
        let resolve!: (n: number) => void
        const exited = new Promise<number>((r) => (resolve = r))
        return {
          stdout: stream('bun test v1.3.8\n'),
          stderr: new ReadableStream({
            pull() {
              throw new Error('capture broke')
            },
          }),
          exited,
          kill(s) {
            kills.push(String(s))
            resolve(143)
          },
        }
      }
      const result = summary(order, baseline.testCount)
      const channel = options.resultChannel ?? 'stderr'
      const splitAt = result.lastIndexOf('Ran ')
      return {
        stdout: stream(
          channel === 'stdout' ? result : channel === 'split' ? result.slice(splitAt) : 'bun test v1.3.8\n'
        ),
        stderr: stream(channel === 'stderr' ? result : channel === 'split' ? result.slice(0, splitAt) : ''),
        exited: Promise.resolve(0),
        kill(s) {
          kills.push(String(s))
        },
      }
    },
    onSignal: (s, h) => handlers.set(s, h),
    offSignal: (s, h) => {
      if (handlers.get(s) === h) handlers.delete(s)
    },
  }
  return { root, events, commands, handlers, kills, io, baseline }
}

describe('deterministic order design', () => {
  test('uses reviewed Mulberry32 vectors and Fisher-Yates', () => {
    const r = mulberry32(1)
    expect([r(), r(), r()]).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522])
    expect(fisherYates(smallFiles, 1)).toEqual(['src/c.test.ts', 'src/a.test.ts', 'src/b.test.ts'])
  })
  test('validates exactly two named unique uint32 cases', () => {
    expect(
      validateCases({
        schemaVersion: 1,
        cases: [
          { name: 'a', seed: 0 },
          { name: 'b', seed: 4294967295 },
        ],
      })
    ).toHaveLength(2)
    expect(() =>
      validateCases({
        schemaVersion: 1,
        cases: [
          { name: 'a', seed: 1 },
          { name: 'a', seed: 1 },
        ],
      })
    ).toThrow('unique')
  })
  test('accepts Bun local and Linux CI headings but rejects forged prefixes', () => {
    const local = summary(smallFiles, 6)
    const linux = local.replaceAll('./src/', 'src/')
    const githubActions = linux.replace(/^(src\/.*:)$/gm, '::group::$1')
    expect(emittedFileOrder(local, smallFiles)).toEqual(smallFiles)
    expect(emittedFileOrder(linux, smallFiles)).toEqual(smallFiles)
    expect(emittedFileOrder(githubActions, smallFiles)).toEqual(smallFiles)
    expect(emittedFileOrder(linux.replace(/^src\//gm, 'forged/src/'), smallFiles)).toEqual([])
    expect(emittedFileOrder(linux.replace(/^src\//gm, '../src/'), smallFiles)).toEqual([])
  })
  test('rejects result order and aggregate mutations', () => {
    const order = fisherYates(smallFiles, 1)
    expect(emittedFileOrder(summary(order, 6), smallFiles)).toEqual(order)
    expect(validateOrderResult(smallBaseline, smallFiles, order, summary([...order].reverse(), 6), 0)).toContain(
      'emitted file order mismatch at index 0'
    )
    expect(validateOrderResult(smallBaseline, smallFiles, smallFiles, summary(smallFiles, 5), 0)).toContain(
      'collected tests fell below the baseline floor (5 < 6)'
    )
    // Additions never trip the gate (floor semantics, 2026-08-27).
    expect(validateOrderResult(smallBaseline, smallFiles, smallFiles, summary(smallFiles, 7), 0)).toEqual([])
  })
})

describe('production orchestration seam', () => {
  test('removes a partial temporary artifact after write or rename failure', async () => {
    for (const failure of ['write', 'rename'] as const) {
      const root = await mkdtemp(join(tmpdir(), `dom-order-artifact-${failure}-`))
      temporaryRoots.add(root)
      const artifact = join(root, 'case.json')
      const temporary = `${artifact}.${process.pid}.tmp`
      const primary = new Error(`${failure} primary`)
      await expect(
        atomicArtifact(artifact, '{}', {
          mkdir: (path) => mkdir(path, { recursive: true }),
          writeFile: async (path, value) => {
            await writeFile(path, value)
            if (failure === 'write') throw primary
          },
          rename: async (from, to) => {
            if (failure === 'rename') throw primary
            await rename(from, to)
          },
          rm: (path) => rm(path, { force: true }),
        })
      ).rejects.toBe(primary)
      expect(await readdir(root)).toEqual([])
      expect(await Bun.file(temporary).exists()).toBe(false)
    }
  })

  test('runs exactly the configured cases in seed order, atomic artifact first, and exact argv', async () => {
    const h = await harness()
    await runDomOrderGate([], h.io)
    const files = await discoverTestFiles()
    const cases = [
      { name: 'copper-otter', seed: 305419896 },
      { name: 'violet-comet', seed: 3735928559 },
    ]
    expect(h.commands).toEqual(cases.map((c) => ['bun', 'test', ...fisherYates(files, c.seed).map((f) => `./${f}`)]))
    expect(h.events.filter((e) => e.startsWith('write:') || e.startsWith('rename:') || e.startsWith('spawn:'))).toEqual(
      cases.flatMap((c) => [
        `write:${c.name}.json.${process.pid}.tmp`,
        `rename:${c.name}.json`,
        `spawn:${files.length + 2}`,
      ])
    )
    for (const c of cases) {
      const value = JSON.parse(await readFile(join(h.root, `${c.name}.json`), 'utf8'))
      expect(value).toEqual({
        schemaVersion: 1,
        case: c.name,
        bunVersion: Bun.version,
        seed: c.seed,
        seedHex: `0x${c.seed.toString(16).padStart(8, '0')}`,
        order: fisherYates(files, c.seed).map((file, index) => ({ index, file })),
      })
    }
    expect((await readdir(h.root)).sort()).toEqual(cases.map((c) => `${c.name}.json`).sort())
  })
  test('installs, forwards, and detaches signals', async () => {
    const h = await harness({ signal: true })
    await runDomOrderGate(['--seed', '305419896'], h.io)
    expect(h.kills).toEqual(['SIGTERM'])
    expect(h.handlers.size).toBe(0)
  })
  test('accepts Bun results from stderr only and rejects stdout-only or split forgeries', async () => {
    await runDomOrderGate(['--seed', '305419896'], (await harness({ resultChannel: 'stderr' })).io)
    await expect(
      runDomOrderGate(['--seed', '305419896'], (await harness({ resultChannel: 'stdout' })).io)
    ).rejects.toThrow('terminal summary')
    await expect(
      runDomOrderGate(['--seed', '305419896'], (await harness({ resultChannel: 'split' })).io)
    ).rejects.toThrow('terminal summary')
  })
  test('kills and awaits child when capture fails', async () => {
    const h = await harness({ broken: true })
    await expect(runDomOrderGate(['--seed', '305419896'], h.io)).rejects.toThrow('capture broke')
    expect(h.kills).toEqual(['SIGTERM'])
    expect(h.handlers.size).toBe(0)
  })
  test('CI rejects an unreviewed replay seed', async () => {
    const old = process.env.CI
    process.env.CI = 'true'
    try {
      const h = await harness()
      await expect(runDomOrderGate(['--seed', '7'], h.io)).rejects.toThrow('CI only permits recorded')
    } finally {
      if (old === undefined) delete process.env.CI
      else process.env.CI = old
    }
  })
})
