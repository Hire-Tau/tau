import { describe, expect, mock, test } from 'bun:test'
import { createHash } from 'crypto'
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent'

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')

type ExactEdit = { oldText: string; newText: string }
type AuthorizedRange = { start: number; end: number; replacement: Buffer }
type VerifiedEditPlan = {
  result: Buffer
  ranges: AuthorizedRange[]
  originalBytes: number
  resultBytes: number
  originalSha256: string
  resultSha256: string
}
type PlannerOptions = {
  assemble?: (original: Buffer, ranges: AuthorizedRange[]) => Buffer
}

async function plan(original: Buffer, edits: ExactEdit[], options?: PlannerOptions): Promise<VerifiedEditPlan> {
  let planner: typeof import('./verified-edit')
  try {
    planner = await import('./verified-edit')
  } catch (cause) {
    throw new Error('PLANNER_UNAVAILABLE_FOR_TDD', { cause })
  }
  return planner.planVerifiedEdit(original, edits, '/private/fixture.ts', options)
}

async function expectBoundedRejection(promise: Promise<unknown>, category: RegExp, forbiddenContent: string[] = []) {
  let rejection: unknown
  try {
    await promise
  } catch (error) {
    rejection = error
  }

  expect(rejection).toBeInstanceOf(Error)
  const message = (rejection as Error).message
  expect(message).toMatch(category)
  expect(Buffer.byteLength(message)).toBeLessThanOrEqual(512)
  for (const forbidden of forbiddenContent) expect(message).not.toContain(forbidden)
}

function assembleAuthorized(original: Buffer, ranges: AuthorizedRange[]): Buffer {
  const chunks: Buffer[] = []
  let offset = 0
  for (const range of ranges) {
    chunks.push(original.subarray(offset, range.start), range.replacement)
    offset = range.end
  }
  chunks.push(original.subarray(offset))
  return Buffer.concat(chunks)
}

function unchangedSlices(original: Buffer, ranges: AuthorizedRange[]) {
  const slices: Array<{ originalStart: number; originalEnd: number; resultStart: number }> = []
  let originalOffset = 0
  let resultOffset = 0
  for (const range of ranges) {
    slices.push({ originalStart: originalOffset, originalEnd: range.start, resultStart: resultOffset })
    resultOffset += range.start - originalOffset + range.replacement.byteLength
    originalOffset = range.end
  }
  slices.push({ originalStart: originalOffset, originalEnd: original.byteLength, resultStart: resultOffset })
  return slices
}

async function expectVerifiedPlan(original: Buffer, edits: ExactEdit[], expected: Buffer) {
  const verified = await plan(original, edits)

  expect(Buffer.compare(verified.result, expected)).toBe(0)
  expect(verified.originalBytes).toBe(original.byteLength)
  expect(verified.resultBytes).toBe(expected.byteLength)
  expect(verified.originalSha256).toBe(sha256(original))
  expect(verified.resultSha256).toBe(sha256(expected))
  for (const slice of unchangedSlices(original, verified.ranges)) {
    const unchanged = original.subarray(slice.originalStart, slice.originalEnd)
    expect(
      Buffer.compare(verified.result.subarray(slice.resultStart, slice.resultStart + unchanged.byteLength), unchanged)
    ).toBe(0)
  }
  return verified
}

describe('planVerifiedEdit byte preservation', () => {
  test('plans two distant replacements and preserves a large suffix sentinel', async () => {
    const middle = 'middle-line\n'.repeat(1_100)
    const suffix = `SUFFIX-BEGIN\n${'s'.repeat(32_000)}\nEOF-SUFFIX-SENTINEL\n`
    const original = Buffer.from(`prefix\nOLD-A\n${middle}OLD-B\n${suffix}`)
    const expected = Buffer.from(`prefix\nNEW-A\n${middle}NEW-B\n${suffix}`)

    const verified = await expectVerifiedPlan(
      original,
      [
        { oldText: 'OLD-A', newText: 'NEW-A' },
        { oldText: 'OLD-B', newText: 'NEW-B' },
      ],
      expected
    )

    expect(verified.result.subarray(-'EOF-SUFFIX-SENTINEL\n'.length).toString()).toBe('EOF-SUFFIX-SENTINEL\n')
  })

  test('plans nearby non-overlapping replacements', async () => {
    await expectVerifiedPlan(
      Buffer.from('prefix OLD-A gap OLD-B suffix'),
      [
        { oldText: 'OLD-A', newText: 'A' },
        { oldText: 'OLD-B', newText: 'B-LONGER' },
      ],
      Buffer.from('prefix A gap B-LONGER suffix')
    )
  })

  test.each([
    ['LF', Buffer.from('a\nOLD\nz\n'), Buffer.from('a\nNEW\nz\n')],
    ['CRLF', Buffer.from('a\r\nOLD\r\nz\r\n'), Buffer.from('a\r\nNEW\r\nz\r\n')],
    ['no final newline', Buffer.from('a\nOLD\nz'), Buffer.from('a\nNEW\nz')],
    [
      'UTF-8 BOM',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('OLD\nz\n')]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('NEW\nz\n')]),
    ],
  ])('preserves %s bytes exactly', async (_name, original, expected) => {
    await expectVerifiedPlan(original, [{ oldText: 'OLD', newText: 'NEW' }], expected)
  })

  test('matches multiline LF edit text against CRLF bytes and preserves CRLF replacement style', async () => {
    await expectVerifiedPlan(
      Buffer.from('prefix\r\nOLD-A\r\nOLD-B\r\nsuffix\r\n'),
      [{ oldText: 'OLD-A\nOLD-B', newText: 'NEW-A\nNEW-B' }],
      Buffer.from('prefix\r\nNEW-A\r\nNEW-B\r\nsuffix\r\n')
    )
  })

  test('preserves a BOM before a multiline CRLF match at the first textual character', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    await expectVerifiedPlan(
      Buffer.concat([bom, Buffer.from('OLD-A\r\nOLD-B\r\n')]),
      [{ oldText: 'OLD-A\nOLD-B', newText: 'NEW-A\nNEW-B' }],
      Buffer.concat([bom, Buffer.from('NEW-A\r\nNEW-B\r\n')])
    )
  })

  test('preserves multibyte bytes before, inside, and after a match', async () => {
    await expectVerifiedPlan(
      Buffer.from('前🙂 café-OLD-雪 後🧪'),
      [{ oldText: 'café-OLD-雪', newText: '咖啡-NEW-雨' }],
      Buffer.from('前🙂 咖啡-NEW-雨 後🧪')
    )
  })

  test('allows a legitimate explicitly authorized large deletion', async () => {
    const deletion = `DELETE-BEGIN\n${'remove-me\n'.repeat(8_000)}DELETE-END\n`
    await expectVerifiedPlan(
      Buffer.from(`prefix\n${deletion}suffix\n`),
      [{ oldText: deletion, newText: '' }],
      Buffer.from('prefix\nsuffix\n')
    )
  })

  test('accepts repeated near-matches when only one byte-exact match exists', async () => {
    await expectVerifiedPlan(
      Buffer.from('target\nTarget \ntarget!\nTARGET\n'),
      [{ oldText: 'Target ', newText: 'EXACT' }],
      Buffer.from('target\nEXACT\ntarget!\nTARGET\n')
    )
  })
})

describe('planVerifiedEdit rejection', () => {
  const unrelatedSentinel = `UNRELATED-SUFFIX-SENTINEL-${'s'.repeat(2_048)}`

  test.each([
    ['empty oldText', Buffer.from('abc'), [{ oldText: '', newText: 'x' }], /oldText.*empty/i, []],
    [
      'missing match',
      Buffer.from(`prefix ${unrelatedSentinel} suffix`),
      [{ oldText: 'missing', newText: 'x' }],
      /not found|missing/i,
      ['UNRELATED-SUFFIX-SENTINEL'],
    ],
    [
      'repeated exact match',
      Buffer.from(`abc abc ${unrelatedSentinel}`),
      [{ oldText: 'abc', newText: 'x' }],
      /unique|multiple|ambiguous/i,
      ['UNRELATED-SUFFIX-SENTINEL'],
    ],
    ['identical result', Buffer.from('abc'), [{ oldText: 'abc', newText: 'abc' }], /identical|no change/i, []],
  ] as const)('rejects %s without producing a plan', async (_name, original, edits, error, forbidden) => {
    await expectBoundedRejection(plan(original, [...edits]), error, [...forbidden])
  })

  test.each([
    [
      'overlapping ranges',
      [
        { oldText: 'abc', newText: 'x' },
        { oldText: 'bc', newText: 'y' },
      ],
    ],
    [
      'nested ranges',
      [
        { oldText: 'abcdef', newText: 'x' },
        { oldText: 'cd', newText: 'y' },
      ],
    ],
  ] as const)('rejects %s', async (_name, edits) => {
    await expectBoundedRejection(plan(Buffer.from('abcdef'), [...edits]), /overlap/i)
  })

  test('rejects invalid UTF-8 input', async () => {
    await expectBoundedRejection(plan(Buffer.from([0x61, 0xff, 0x62]), [{ oldText: 'a', newText: 'x' }]), /utf-?8/i)
  })

  test.each([
    [
      'dropped unchanged suffix',
      (_original: Buffer, ranges: AuthorizedRange[]) => Buffer.concat([Buffer.from('prefix '), ranges[0].replacement]),
    ],
    [
      'dropped interstitial bytes',
      (original: Buffer, ranges: AuthorizedRange[]) =>
        Buffer.concat([
          original.subarray(0, ranges[0].start),
          ranges[0].replacement,
          ranges[1].replacement,
          original.subarray(ranges[1].end),
        ]),
    ],
    [
      'wrong range offset',
      (original: Buffer, ranges: AuthorizedRange[]) =>
        Buffer.concat([original.subarray(1, ranges[0].start), ranges[0].replacement, original.subarray(ranges[0].end)]),
    ],
    [
      'same-length unchanged suffix corruption',
      (original: Buffer, ranges: AuthorizedRange[]) => {
        const result = assembleAuthorized(original, ranges)
        result[result.byteLength - 1] ^= 1
        return result
      },
    ],
    [
      'same-length replacement corruption',
      (original: Buffer, ranges: AuthorizedRange[]) => {
        const result = assembleAuthorized(original, ranges)
        result[ranges[0].start] ^= 1
        return result
      },
    ],
  ] as const)('rejects an injected assembler with %s', async (_name, assemble) => {
    const original = Buffer.from('prefix OLD-A middle OLD-B suffix')
    const edits =
      _name === 'dropped interstitial bytes'
        ? [
            { oldText: 'OLD-A', newText: 'NEW-A' },
            { oldText: 'OLD-B', newText: 'NEW-B' },
          ]
        : [{ oldText: 'OLD-A', newText: 'NEW-A' }]

    await expectBoundedRejection(plan(original, edits, { assemble }), /integrity|unchanged|replacement|length/i, [
      'OLD-A',
      'OLD-B',
    ])
  })
})

type ExecutorIdentity = { bytes: number; sha256: string }
type ExecutorCommit = {
  path: string
  result: Buffer
  identity: { original: ExecutorIdentity; result: ExecutorIdentity }
}
type ExecutorOperations = {
  access: ReturnType<typeof mock>
  readFile: ReturnType<typeof mock>
  commitFile: ReturnType<typeof mock>
}

async function createExecutor(operations: ExecutorOperations) {
  const module = await import('./verified-edit')
  const factory = (
    module as typeof module & {
      createVerifiedEditTool?: (
        cwd: string,
        operations: ExecutorOperations
      ) => {
        execute(callId: string, params: unknown, signal?: AbortSignal): Promise<any>
      }
    }
  ).createVerifiedEditTool
  if (typeof factory !== 'function') throw new Error('VERIFIED_EDIT_EXECUTOR_UNAVAILABLE_FOR_TDD')
  return factory('/workspace', operations)
}

function executorOperations(
  original: Buffer,
  options: {
    response?: (
      commit: ExecutorCommit
    ) => { bytesWritten: number; sha256: string } | Promise<{ bytesWritten: number; sha256: string }>
    readback?: Buffer
  } = {}
) {
  let stored = Buffer.from(original)
  let reads = 0
  const access = mock(async () => undefined)
  const readFile = mock(async () => {
    reads += 1
    return reads === 1 ? Buffer.from(original) : Buffer.from(options.readback ?? stored)
  })
  const commitFile = mock(async (path: string, result: Buffer, identity: ExecutorCommit['identity']) => {
    const commit = { path, result: Buffer.from(result), identity }
    stored = Buffer.from(result)
    return options.response?.(commit) ?? { bytesWritten: result.byteLength, sha256: sha256(result) }
  })
  return { access, readFile, commitFile }
}

const executeInput = (tool: Awaited<ReturnType<typeof createExecutor>>, params: unknown, signal?: AbortSignal) =>
  tool.execute('verified-edit-test', params, signal)

async function withReadinessTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`READINESS_TIMEOUT:${label}`)), 2_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('verified edit executor', () => {
  test('normalizes batch arrays and JSON-string edit batches', async () => {
    const original = Buffer.from('prefix OLD-A middle OLD-B suffix')
    const expected = Buffer.from('prefix NEW-A middle NEW-B suffix')
    for (const edits of [
      [
        { oldText: 'OLD-A', newText: 'NEW-A' },
        { oldText: 'OLD-B', newText: 'NEW-B' },
      ],
      JSON.stringify([
        { oldText: 'OLD-A', newText: 'NEW-A' },
        { oldText: 'OLD-B', newText: 'NEW-B' },
      ]),
    ]) {
      const operations = executorOperations(original)
      const tool = await createExecutor(operations)
      await executeInput(tool, { path: '/workspace/fixture.ts', edits })
      expect(operations.commitFile).toHaveBeenCalledTimes(1)
      expect(Buffer.compare(operations.commitFile.mock.calls[0][1], expected)).toBe(0)
    }
  })

  test('normalizes the legacy oldText and newText input', async () => {
    const operations = executorOperations(Buffer.from('prefix OLD suffix'))
    const tool = await createExecutor(operations)
    await executeInput(tool, { path: '/workspace/fixture.ts', oldText: 'OLD', newText: 'NEW' })
    expect(operations.commitFile).toHaveBeenCalledTimes(1)
    expect(operations.commitFile.mock.calls[0][1].toString()).toBe('prefix NEW suffix')
  })

  test('fails closed with zero commit for mixed missing, ambiguous, and overlapping edits', async () => {
    const fixtures = [
      {
        original: Buffer.from('prefix PRESENT suffix'),
        edits: [
          { oldText: 'PRESENT', newText: 'NEW' },
          { oldText: 'MISSING', newText: 'NO' },
        ],
        category: /missing|not found/i,
      },
      {
        original: Buffer.from('dup middle dup'),
        edits: [{ oldText: 'dup', newText: 'one' }],
        category: /ambiguous|unique|multiple/i,
      },
      {
        original: Buffer.from('abcdef'),
        edits: [
          { oldText: 'abc', newText: 'x' },
          { oldText: 'bc', newText: 'y' },
        ],
        category: /overlap/i,
      },
    ]
    for (const fixture of fixtures) {
      const operations = executorOperations(fixture.original)
      const tool = await createExecutor(operations)
      await expectBoundedRejection(
        executeInput(tool, { path: '/workspace/fixture.ts', edits: fixture.edits }),
        fixture.category,
        ['PRESENT', 'MISSING', 'dup middle dup', 'abcdef']
      )
      expect(operations.commitFile).not.toHaveBeenCalled()
    }
  })

  test('commits exact original and result identities and verifies the response', async () => {
    const original = Buffer.from('prefix OLD suffix')
    const expected = Buffer.from('prefix NEW suffix')
    const operations = executorOperations(original)
    const tool = await createExecutor(operations)
    await executeInput(tool, { path: '/workspace/fixture.ts', edits: [{ oldText: 'OLD', newText: 'NEW' }] })
    expect(operations.commitFile).toHaveBeenCalledTimes(1)
    expect(operations.commitFile.mock.calls[0]).toEqual([
      '/workspace/fixture.ts',
      expected,
      {
        original: { bytes: original.byteLength, sha256: sha256(original) },
        result: { bytes: expected.byteLength, sha256: sha256(expected) },
      },
    ])
  })

  test('suppresses success on a commit response identity mismatch', async () => {
    const sensitive = `UNRELATED-${'x'.repeat(2048)}`
    const original = Buffer.from(`prefix OLD suffix ${sensitive}`)
    const operations = executorOperations(original, {
      response: (commit) => ({ bytesWritten: commit.result.byteLength, sha256: '0'.repeat(64) }),
    })
    const tool = await createExecutor(operations)
    await expectBoundedRejection(
      executeInput(tool, { path: '/workspace/fixture.ts', edits: [{ oldText: 'OLD', newText: 'NEW' }] }),
      /response|identity|integrity|published/i,
      ['/workspace/fixture.ts', sensitive]
    )
    expect(operations.readFile).toHaveBeenCalledTimes(1)
  })

  test('suppresses success when the complete final readback identity mismatches', async () => {
    const expected = Buffer.from('prefix NEW suffix')
    const operations = executorOperations(Buffer.from('prefix OLD suffix'), {
      readback: Buffer.concat([expected, Buffer.from('\nCORRUPT-TAIL')]),
    })
    const tool = await createExecutor(operations)
    await expectBoundedRejection(
      executeInput(tool, { path: '/workspace/fixture.ts', edits: [{ oldText: 'OLD', newText: 'NEW' }] }),
      /readback|identity|integrity|published/i,
      ['CORRUPT-TAIL']
    )
    expect(operations.commitFile).toHaveBeenCalledTimes(1)
    expect(operations.readFile).toHaveBeenCalledTimes(2)
  })

  test('honors abort checkpoints without releasing around an unsettled commit', async () => {
    const preAborted = new AbortController()
    preAborted.abort()
    const preAbortOperations = executorOperations(Buffer.from('prefix OLD suffix'))
    const preAbortTool = await createExecutor(preAbortOperations)
    await expect(
      executeInput(
        preAbortTool,
        { path: '/workspace/fixture.ts', edits: [{ oldText: 'OLD', newText: 'NEW' }] },
        preAborted.signal
      )
    ).rejects.toThrow(/abort/i)
    expect(preAbortOperations.access).not.toHaveBeenCalled()
    expect(preAbortOperations.readFile).not.toHaveBeenCalled()
    expect(preAbortOperations.commitFile).not.toHaveBeenCalled()

    let releaseCommit!: () => void
    let markCommitStarted!: () => void
    let queueProbe: Promise<void> | undefined
    let probeObservedSettled: boolean | undefined
    let commitSettled = false
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve
    })
    const commitBarrier = new Promise<void>((resolve) => {
      releaseCommit = resolve
    })
    const operations = executorOperations(Buffer.from('prefix OLD suffix'), {
      response: async (commit) => {
        queueProbe = withFileMutationQueue('/workspace/fixture.ts', async () => {
          probeObservedSettled = commitSettled
        })
        // The Pi queue serializes registration independently from execution.
        // Completing a later different-path registration proves the same-path
        // probe is registered before the commit is released.
        await withFileMutationQueue('/workspace/queue-registration-sentinel', async () => undefined)
        markCommitStarted()
        await commitBarrier
        commitSettled = true
        return { bytesWritten: commit.result.byteLength, sha256: sha256(commit.result) }
      },
    })
    const tool = await createExecutor(operations)
    const controller = new AbortController()
    const execution = executeInput(
      tool,
      { path: '/workspace/fixture.ts', edits: [{ oldText: 'OLD', newText: 'NEW' }] },
      controller.signal
    )
    await withReadinessTimeout(commitStarted, 'commit-started')
    controller.abort()
    releaseCommit()
    const postCommitError = await execution.catch((error) => error as Error)
    expect(postCommitError).toBeInstanceOf(Error)
    expect(postCommitError.message).toContain('operation aborted after commit settled')
    expect(postCommitError.message).toContain('candidate may have been published')
    expect(postCommitError.message).toContain('success was not reported')
    expect(Buffer.byteLength(postCommitError.message, 'utf8')).toBeLessThanOrEqual(512)
    expect(queueProbe).toBeDefined()
    await withReadinessTimeout(queueProbe!, 'same-path-queue-probe')
    expect(commitSettled).toBe(true)
    expect(probeObservedSettled).toBe(true)
    expect(operations.commitFile).toHaveBeenCalledTimes(1)
  })

  test('reports post-publication uncertainty for abort after final readback without releasing the queue early', async () => {
    const original = Buffer.from('prefix OLD suffix')
    const result = Buffer.from('prefix NEW suffix')
    const operations = executorOperations(original)
    let reads = 0
    let releaseReadback!: () => void
    let markReadbackStarted!: () => void
    let readbackSettled = false
    let probeObservedSettled: boolean | undefined
    let queueProbe: Promise<void> | undefined
    const readbackStarted = new Promise<void>((resolve) => {
      markReadbackStarted = resolve
    })
    const readbackBarrier = new Promise<void>((resolve) => {
      releaseReadback = resolve
    })
    operations.readFile = mock(async () => {
      reads += 1
      if (reads === 1) return original
      queueProbe = withFileMutationQueue('/workspace/fixture.ts', async () => {
        probeObservedSettled = readbackSettled
      })
      await withFileMutationQueue('/workspace/readback-registration-sentinel', async () => undefined)
      markReadbackStarted()
      await readbackBarrier
      readbackSettled = true
      return result
    })
    const tool = await createExecutor(operations)
    const controller = new AbortController()
    const execution = executeInput(
      tool,
      { path: '/workspace/fixture.ts', edits: [{ oldText: 'OLD', newText: 'NEW' }] },
      controller.signal
    )
    await withReadinessTimeout(readbackStarted, 'readback-started')
    controller.abort()
    releaseReadback()
    const error = await execution.catch((failure) => failure as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('operation aborted after commit settled')
    expect(error.message).toContain('candidate may have been published')
    expect(error.message).toContain('success was not reported')
    expect(Buffer.byteLength(error.message, 'utf8')).toBeLessThanOrEqual(512)
    expect(queueProbe).toBeDefined()
    await withReadinessTimeout(queueProbe!, 'readback-queue-probe')
    expect(readbackSettled).toBe(true)
    expect(probeObservedSettled).toBe(true)
    expect(operations.commitFile).toHaveBeenCalledTimes(1)
    expect(operations.readFile).toHaveBeenCalledTimes(2)
  })

  test('returns bounded success diagnostics with verified identity details metadata', async () => {
    const original = Buffer.from('prefix OLD suffix')
    const expected = Buffer.from('prefix NEW suffix')
    const operations = executorOperations(original)
    const tool = await createExecutor(operations)
    const output = await executeInput(tool, {
      path: '/workspace/fixture.ts',
      edits: [{ oldText: 'OLD', newText: 'NEW' }],
    })
    const text = output.content.find((item: { type: string }) => item.type === 'text')?.text ?? ''
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512)
    expect(text).toContain('Successfully replaced 1 block(s)')
    expect(text).toContain(`${original.byteLength} -> ${expected.byteLength} bytes`)
    expect(output.details).toMatchObject({
      originalBytes: original.byteLength,
      resultBytes: expected.byteLength,
      originalSha256: sha256(original),
      resultSha256: sha256(expected),
      replacementCount: 1,
      firstLine: 1,
    })
    expect(typeof output.details.diff).toBe('string')
    expect(typeof output.details.patch).toBe('string')
  })
})
