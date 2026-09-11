import { afterEach, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { amtpNodeCommand } from './node-conformance-command'
import { runFileCapturedProcess } from './node-conformance-process'
import { inspectUploadPremise, uploadNodeAttachment } from './node-conformance-attachment-upload'
import { openNodeConformanceDb } from './node-conformance-sqlite'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs.length = 0
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amtp-upload-audit-'))
  dirs.push(root)
  const home = join(root, 'home')
  const captureDir = join(root, 'captures')
  await Bun.write(join(root, '.keep'), '')
  await (await import('node:fs/promises')).mkdir(captureDir)
  const nodeEntry = Bun.resolveSync('amtp-node', import.meta.dir)
  const init = await runFileCapturedProcess(
    amtpNodeCommand(process.execPath, nodeEntry, ['--home', home, '--json', 'init']),
    {
      phase: 'amtp-cli:init',
      timeoutMs: 5_000,
      captureDir,
    }
  )
  expect(init.exitCode).toBe(0)
  return { root, home, captureDir, nodeEntry }
}

test('opens audit connections with node SQLite safety pragmas', async () => {
  const { home } = await fixture()
  const sqlite = openNodeConformanceDb(home, { readonly: true })
  try {
    expect(sqlite.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
    expect(sqlite.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()?.timeout).toBe(5_000)
    expect(sqlite.query<{ synchronous: number }, []>('PRAGMA synchronous').get()?.synchronous).toBe(2)
    expect(sqlite.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1)
  } finally {
    sqlite.close()
  }
}, 30_000)

test('asserts source bytes and target absence before upload', async () => {
  const { root, home } = await fixture()
  const expectedBytes = Buffer.from('unique-audited-bytes')
  const filePath = join(root, 'unique.txt')
  await writeFile(filePath, expectedBytes)

  const premise = await inspectUploadPremise({ home, filePath, expectedBytes })

  expect(premise).toMatchObject({
    filename: 'unique.txt',
    byteSize: expectedBytes.byteLength,
    sha256: createHash('sha256').update(expectedBytes).digest('hex'),
    matchingRows: [],
  })
})

test('rejects a wrong terminal digest and cleans only its attributed row and blob', async () => {
  const { root, home, captureDir, nodeEntry } = await fixture()
  const expectedBytes = Buffer.from('digest-audit')
  const filePath = join(root, 'digest.txt')
  await writeFile(filePath, expectedBytes)
  const attachmentId = randomUUID()
  const sha256 = createHash('sha256').update(expectedBytes).digest('hex')

  const runProcess: typeof runFileCapturedProcess = async () => {
    await writeFile(join(home, 'blobs', attachmentId), expectedBytes)
    const sqlite = openNodeConformanceDb(home)
    try {
      sqlite.run(
        `INSERT INTO attachments (id, message_id, direction, filename, content_type, byte_size, sha256, storage_path, created_at)
         VALUES (?, NULL, 'out', ?, ?, ?, ?, ?, ?)`,
        [attachmentId, 'digest.txt', 'application/octet-stream', expectedBytes.length, sha256, attachmentId, Date.now()]
      )
    } finally {
      sqlite.close()
    }
    return {
      pid: 1,
      exitCode: 0,
      signalCode: null,
      stdout: JSON.stringify({
        attachmentId,
        filename: 'digest.txt',
        contentType: 'application/octet-stream',
        byteSize: expectedBytes.length,
        sha256: '0'.repeat(64),
      }),
      stderr: '',
    }
  }

  await expect(
    uploadNodeAttachment({ home, captureDir, nodeEntry, filePath, expectedBytes, timeoutMs: 5_000 }, { runProcess })
  ).rejects.toThrow('attachment-persistence-integrity')
  expect(await readdir(join(home, 'blobs'))).toEqual(['tmp'])
})

test('cleans one uniquely attributable pre-terminal row and blob', async () => {
  const { root, home, captureDir, nodeEntry } = await fixture()
  const expectedBytes = Buffer.from('pre-terminal')
  const filePath = join(root, 'pre-terminal.txt')
  await writeFile(filePath, expectedBytes)
  const attachmentId = randomUUID()
  const sha256 = createHash('sha256').update(expectedBytes).digest('hex')

  const runProcess: typeof runFileCapturedProcess = async () => {
    await writeFile(join(home, 'blobs', attachmentId), expectedBytes)
    const sqlite = openNodeConformanceDb(home)
    try {
      sqlite.run(
        `INSERT INTO attachments (id, message_id, direction, filename, content_type, byte_size, sha256, storage_path, created_at)
         VALUES (?, NULL, 'out', ?, ?, ?, ?, ?, ?)`,
        [
          attachmentId,
          'pre-terminal.txt',
          'application/octet-stream',
          expectedBytes.length,
          sha256,
          attachmentId,
          Date.now(),
        ]
      )
    } finally {
      sqlite.close()
    }
    throw new Error('terminal output missing')
  }

  await expect(
    uploadNodeAttachment({ home, captureDir, nodeEntry, filePath, expectedBytes, timeoutMs: 5_000 }, { runProcess })
  ).rejects.toThrow('terminal output missing')
  expect(await readdir(join(home, 'blobs'))).toEqual(['tmp'])
})

test('refuses destructive cleanup when pre-terminal attribution is ambiguous', async () => {
  const { root, home, captureDir, nodeEntry } = await fixture()
  const expectedBytes = Buffer.from('ambiguous')
  const filePath = join(root, 'ambiguous.txt')
  await writeFile(filePath, expectedBytes)
  const ids = [randomUUID(), randomUUID()]
  const sha256 = createHash('sha256').update(expectedBytes).digest('hex')

  const runProcess: typeof runFileCapturedProcess = async () => {
    const sqlite = openNodeConformanceDb(home)
    try {
      for (const id of ids) {
        await writeFile(join(home, 'blobs', id), expectedBytes)
        sqlite.run(
          `INSERT INTO attachments (id, message_id, direction, filename, content_type, byte_size, sha256, storage_path, created_at)
           VALUES (?, NULL, 'out', ?, ?, ?, ?, ?, ?)`,
          [id, 'ambiguous.txt', 'application/octet-stream', expectedBytes.length, sha256, id, Date.now()]
        )
      }
    } finally {
      sqlite.close()
    }
    throw new Error('terminal output missing')
  }

  await expect(
    uploadNodeAttachment({ home, captureDir, nodeEntry, filePath, expectedBytes, timeoutMs: 5_000 }, { runProcess })
  ).rejects.toThrow('attachment-cleanup-attribution-ambiguous')
  expect((await readdir(join(home, 'blobs'))).sort()).toEqual([...ids, 'tmp'].sort())
})

test('launches upload with the exact executable and installed entrypoint', async () => {
  const { root, home, captureDir, nodeEntry } = await fixture()
  const expectedBytes = Buffer.from('exact-launch-identity')
  const filePath = join(root, 'exact-launch.txt')
  await writeFile(filePath, expectedBytes)
  let command: string[] | undefined

  const upload = await uploadNodeAttachment(
    { home, captureDir, nodeEntry, filePath, expectedBytes, timeoutMs: 5_000 },
    {
      runProcess: (actualCommand, options) => {
        command = actualCommand
        return runFileCapturedProcess(actualCommand, options)
      },
    }
  )

  expect(command).toEqual([process.execPath, nodeEntry, '--home', home, '--json', 'attach', 'upload', filePath])
  await upload.dispose()
  expect(await readdir(captureDir)).toEqual([])
})

test('uploads and audits exactly one row and durable blob', async () => {
  const { root, home, captureDir, nodeEntry } = await fixture()
  const sentinelBytes = Buffer.from('unrelated-sentinel')
  const sentinelPath = join(root, 'sentinel.txt')
  await writeFile(sentinelPath, sentinelBytes)
  const sentinel = await uploadNodeAttachment({
    home,
    captureDir,
    nodeEntry,
    filePath: sentinelPath,
    expectedBytes: sentinelBytes,
    timeoutMs: 5_000,
  })

  const expectedBytes = Buffer.from('persisted-once')
  const filePath = join(root, 'audited.txt')
  await writeFile(filePath, expectedBytes)

  const upload = await uploadNodeAttachment({
    home,
    captureDir,
    nodeEntry,
    filePath,
    expectedBytes,
    timeoutMs: 5_000,
  })

  expect(upload).toMatchObject({
    filename: 'audited.txt',
    contentType: 'application/octet-stream',
    byteSize: expectedBytes.byteLength,
    sha256: createHash('sha256').update(expectedBytes).digest('hex'),
  })
  expect(await readFile(join(home, 'blobs', upload.attachmentId))).toEqual(expectedBytes)
  expect(await readdir(join(home, 'blobs', 'tmp'))).toEqual([])

  await upload.dispose()
  await upload.dispose()
  expect((await readdir(join(home, 'blobs'))).sort()).toEqual([sentinel.attachmentId, 'tmp'].sort())
  expect(await readFile(join(home, 'blobs', sentinel.attachmentId))).toEqual(sentinelBytes)
  await sentinel.dispose()
})
