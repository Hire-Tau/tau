import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..')
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const dockerfile = readFileSync(resolve(repoRoot, 'apps/core/docker-sandbox/Dockerfile'), 'utf8')

describe('Docker sandbox image source contract', () => {
  test('builds from repository root with pinned Bun and a baked executor', () => {
    expect(packageJson.scripts['sandbox:build:docker']).toEndWith('-f apps/core/docker-sandbox/Dockerfile .')
    expect(readFileSync(resolve(repoRoot, '.bun-version'), 'utf8').trim()).toBe('1.3.8')
    expect(dockerfile).toContain('ARG BUN_VERSION=1.3.8')
    expect(dockerfile).toContain('packages/k8s-sandbox/src')
    expect(dockerfile).toContain('apps/core/docker-sandbox/command-identity.json')
  })

  test('declares the negotiated runtime and installs identity/proxy tools', () => {
    for (const label of [
      'io.hiretau.sandbox.managed="true"',
      'io.hiretau.sandbox.runtime-contract="1"',
      'io.hiretau.sandbox.executor-protocol="1"',
      'io.hiretau.sandbox.command-contract="1"',
    ])
      expect(dockerfile).toContain(label)
    expect(dockerfile).toMatch(/\bsocat\b/)
    expect(dockerfile).toMatch(/\bsu-exec\b/)
    expect(dockerfile).not.toContain('NOPASSWD')
  })
})
