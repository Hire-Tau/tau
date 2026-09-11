import { describe, expect, test, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  devboxHasPackages,
  prepareDevboxShellEnv,
  cacheDevboxShellEnv,
  getDevboxShellEnv,
  refreshDevboxShellEnvIfDirty,
  shouldSelfCacheDevboxEnvOnBoot,
  selfCacheDevboxEnvOnBoot,
  cacheManagedToolchainEnv,
  clearManagedToolchainEnv,
} from './devbox-env'

function writeDevbox(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'devbox-env-'))
  const path = join(dir, 'devbox.json')
  writeFileSync(path, contents)
  return path
}

describe('devboxHasPackages', () => {
  test('empty package array → false (the agent light box default)', () => {
    expect(devboxHasPackages(writeDevbox('{"packages":[]}'))).toBe(false)
  })

  test('populated package array → true', () => {
    expect(devboxHasPackages(writeDevbox('{"packages":["nodejs_24@latest"]}'))).toBe(true)
  })

  test('missing packages key → false', () => {
    expect(devboxHasPackages(writeDevbox('{}'))).toBe(false)
  })

  test('missing file or malformed JSON → false (never throws)', () => {
    expect(devboxHasPackages('/no/such/devbox.json')).toBe(false)
    expect(devboxHasPackages(writeDevbox('{ not json'))).toBe(false)
  })
})

describe('cacheDevboxShellEnv skip paths (no event-loop-blocking devbox shellenv)', () => {
  const prevWorkspace = process.env.WORKSPACE_PATH
  const prevDevboxDir = process.env.TAU_DEVBOX_DIR

  afterEach(() => {
    if (prevWorkspace === undefined) delete process.env.WORKSPACE_PATH
    else process.env.WORKSPACE_PATH = prevWorkspace
    if (prevDevboxDir === undefined) delete process.env.TAU_DEVBOX_DIR
    else process.env.TAU_DEVBOX_DIR = prevDevboxDir
  })

  test('empty-packages devbox.json is skipped — cache stays empty, no shellenv run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-env-ws-'))
    writeFileSync(join(dir, 'devbox.json'), '{"packages":[]}')
    process.env.WORKSPACE_PATH = dir
    delete process.env.TAU_DEVBOX_DIR

    // Must return promptly without invoking `devbox shellenv` (which would hang
    // ~30s against an un-realized empty devbox and block the server event loop).
    const start = performance.now()
    cacheDevboxShellEnv()
    const elapsedMs = performance.now() - start

    expect(getDevboxShellEnv()).toBe('')
    expect(elapsedMs).toBeLessThan(1000)
    rmSync(dir, { recursive: true, force: true })
  })

  test('missing devbox.json is skipped — cache stays empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-env-ws-'))
    process.env.WORKSPACE_PATH = dir
    delete process.env.TAU_DEVBOX_DIR
    cacheDevboxShellEnv()
    expect(getDevboxShellEnv()).toBe('')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('managed toolchain shellenv cache', () => {
  const previousToolchainDir = process.env.TAU_TOOLCHAIN_DIR
  const dirs: string[] = []

  afterEach(() => {
    clearManagedToolchainEnv()
    if (previousToolchainDir === undefined) delete process.env.TAU_TOOLCHAIN_DIR
    else process.env.TAU_TOOLCHAIN_DIR = previousToolchainDir
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('appends managed activation after the existing cache when Core requests it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'managed-devbox-'))
    dirs.push(dir)
    process.env.TAU_TOOLCHAIN_DIR = dir
    writeFileSync(join(dir, 'devbox.json'), '{"packages":["python3@latest"]}')
    const existingCache = getDevboxShellEnv()

    cacheManagedToolchainEnv(false, () => 'should not run')
    expect(getDevboxShellEnv()).toBe(existingCache)

    cacheManagedToolchainEnv(true, () => 'export MANAGED=1')
    expect(getDevboxShellEnv()).toBe([existingCache, 'export MANAGED=1'].filter(Boolean).join('\n'))
  })

  test('clears stale activation when files disappear', () => {
    const dir = mkdtempSync(join(tmpdir(), 'managed-devbox-'))
    dirs.push(dir)
    process.env.TAU_TOOLCHAIN_DIR = dir
    writeFileSync(join(dir, 'devbox.json'), '{"packages":["python3@latest"]}')
    writeFileSync(join(dir, '.ready'), 'fingerprint')
    cacheManagedToolchainEnv(true, () => 'export MANAGED=1')
    rmSync(join(dir, 'devbox.json'))
    expect(() => cacheManagedToolchainEnv(true, () => 'should not run')).toThrow()
    expect(getDevboxShellEnv()).not.toContain('MANAGED')
  })
})

describe('refreshDevboxShellEnvIfDirty', () => {
  const previousBoxHome = process.env.TAU_BOX_HOME
  const previousDevboxDir = process.env.TAU_DEVBOX_DIR
  afterEach(() => {
    if (previousBoxHome === undefined) delete process.env.TAU_BOX_HOME
    else process.env.TAU_BOX_HOME = previousBoxHome
    if (previousDevboxDir === undefined) delete process.env.TAU_DEVBOX_DIR
    else process.env.TAU_DEVBOX_DIR = previousDevboxDir
  })

  test('consumes VM dirty markers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-dirty-'))
    process.env.TAU_BOX_HOME = '/home/box_x'
    process.env.TAU_DEVBOX_DIR = dir
    writeFileSync(join(dir, 'devbox.json'), '{"packages":[]}')
    const marker = join(dir, '.shellenv-dirty.123')
    writeFileSync(marker, '')

    refreshDevboxShellEnvIfDirty()

    expect(existsSync(marker)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('replaces the cached shellenv from a non-empty VM devbox after consuming a marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-dirty-'))
    process.env.TAU_BOX_HOME = '/home/box_x'
    process.env.TAU_DEVBOX_DIR = dir
    writeFileSync(join(dir, 'devbox.json'), '{"packages":["cowsay@latest"]}')

    cacheDevboxShellEnv(() => 'export CACHED_TOOL=before')
    expect(getDevboxShellEnv()).toContain('CACHED_TOOL=before')

    const marker = join(dir, '.shellenv-dirty.123')
    writeFileSync(marker, '')
    refreshDevboxShellEnvIfDirty(() => 'export CACHED_TOOL=after')

    expect(existsSync(marker)).toBe(false)
    expect(getDevboxShellEnv()).toContain('CACHED_TOOL=after')
    rmSync(dir, { recursive: true, force: true })
  })

  test('does not consume markers outside VM boxes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-dirty-'))
    delete process.env.TAU_BOX_HOME
    process.env.TAU_DEVBOX_DIR = dir
    const marker = join(dir, '.shellenv-dirty.123')
    writeFileSync(marker, '')

    refreshDevboxShellEnvIfDirty()

    expect(existsSync(marker)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('shouldSelfCacheDevboxEnvOnBoot (vm box boot self-cache gate)', () => {
  const prevBoxHome = process.env.TAU_BOX_HOME
  const prevDevboxDir = process.env.TAU_DEVBOX_DIR
  const prevWorkspace = process.env.WORKSPACE_PATH
  const dirs: string[] = []

  function restore(name: string, prev: string | undefined): void {
    if (prev === undefined) delete process.env[name]
    else process.env[name] = prev
  }

  afterEach(() => {
    restore('TAU_BOX_HOME', prevBoxHome)
    restore('TAU_DEVBOX_DIR', prevDevboxDir)
    restore('WORKSPACE_PATH', prevWorkspace)
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function devboxDirWith(contents: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-boot-'))
    dirs.push(dir)
    if (contents !== null) writeFileSync(join(dir, 'devbox.json'), contents)
    return dir
  }

  test('TAU_BOX_HOME set + devbox.json declaring packages → true (vm box, seeded)', () => {
    process.env.TAU_BOX_HOME = '/home/box_x'
    process.env.TAU_DEVBOX_DIR = devboxDirWith('{"packages":["ripgrep@latest"]}')
    expect(shouldSelfCacheDevboxEnvOnBoot()).toBe(true)
  })

  test('boot self-cache reports success only when shellenv was actually cached', () => {
    process.env.TAU_BOX_HOME = '/home/box_x'
    process.env.TAU_DEVBOX_DIR = devboxDirWith('{"packages":["ripgrep@latest"]}')
    expect(selfCacheDevboxEnvOnBoot(() => 'export PATH=/realized/bin')).toBe(true)
    expect(
      selfCacheDevboxEnvOnBoot(() => {
        throw new Error('not realized')
      })
    ).toBe(false)
  })

  test('TAU_BOX_HOME set + empty-packages devbox.json → false (un-realized; shellenv would hang)', () => {
    process.env.TAU_BOX_HOME = '/home/box_x'
    process.env.TAU_DEVBOX_DIR = devboxDirWith('{"packages":[]}')
    expect(shouldSelfCacheDevboxEnvOnBoot()).toBe(false)
  })

  test('TAU_BOX_HOME set + missing devbox.json → false (nothing to cache)', () => {
    process.env.TAU_BOX_HOME = '/home/box_x'
    process.env.TAU_DEVBOX_DIR = devboxDirWith(null)
    expect(shouldSelfCacheDevboxEnvOnBoot()).toBe(false)
  })

  test('TAU_BOX_HOME UNSET → false even with a packaged devbox.json (k8s/docker boot parity)', () => {
    delete process.env.TAU_BOX_HOME
    process.env.TAU_DEVBOX_DIR = devboxDirWith('{"packages":["ripgrep@latest"]}')
    expect(shouldSelfCacheDevboxEnvOnBoot()).toBe(false)
  })
})

describe('prepareDevboxShellEnv readiness proof', () => {
  test('accepts empty global-profile config and rejects unrealized populated config', () => {
    const previous = process.env.TAU_DEVBOX_DIR
    const dir = mkdtempSync(join(tmpdir(), 'devbox-prepare-'))
    try {
      process.env.TAU_DEVBOX_DIR = dir
      writeFileSync(join(dir, 'devbox.json'), '{"packages":[]}')
      expect(
        prepareDevboxShellEnv(() => {
          throw new Error('must not run')
        })
      ).toBe(true)
      writeFileSync(join(dir, 'devbox.json'), '{"packages":["nodejs"]}')
      expect(
        prepareDevboxShellEnv(() => {
          throw new Error('not realized')
        })
      ).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.TAU_DEVBOX_DIR
      else process.env.TAU_DEVBOX_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
