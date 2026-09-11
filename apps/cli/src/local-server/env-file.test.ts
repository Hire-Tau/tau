import { describe, expect, it } from 'bun:test'
import { mergeEnvFile, parseEnvFile, renderEnvDiff } from './env-file'

const base = `# Web
TAU_SERVE_WEB=1
TAU_API_URL=http://localhost:3000

# Encryption
TAU_ENCRYPTION_KEY=
APP_URL=https://your-domain.com
DATABASE_URL=postgres://postgres:postgres@localhost:5432/tau
`

describe('parseEnvFile', () => {
  it('returns key/value pairs and ignores comments and blanks', () => {
    expect(parseEnvFile(base)).toEqual({
      TAU_SERVE_WEB: '1',
      TAU_API_URL: 'http://localhost:3000',
      TAU_ENCRYPTION_KEY: '',
      APP_URL: 'https://your-domain.com',
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/tau',
    })
  })
  it('strips matching quotes', () => {
    expect(parseEnvFile(`A="x y"\nB='z'\n`)).toEqual({ A: 'x y', B: 'z' })
  })
})

describe('mergeEnvFile', () => {
  it('fills an empty managed key in place and keeps everything else byte-identical', () => {
    const out = mergeEnvFile(base, [{ key: 'TAU_ENCRYPTION_KEY', value: 'abc', explicit: false }])
    expect(out).toBe(base.replace('TAU_ENCRYPTION_KEY=', 'TAU_ENCRYPTION_KEY=abc'))
  })
  it('keeps an existing non-empty value when the update is not explicit', () => {
    const out = mergeEnvFile(base, [{ key: 'TAU_API_URL', value: 'http://localhost:4000', explicit: false }])
    expect(out).toBe(base)
  })
  it('replaces an existing value when the update is explicit', () => {
    const out = mergeEnvFile(base, [{ key: 'TAU_API_URL', value: 'http://localhost:4000', explicit: true }])
    expect(out).toContain('TAU_API_URL=http://localhost:4000\n')
    expect(out).not.toContain('localhost:3000')
  })
  it('treats the .env.example APP_URL placeholder as empty', () => {
    const out = mergeEnvFile(base, [{ key: 'APP_URL', value: 'http://localhost:3000', explicit: false }])
    expect(out).toContain('APP_URL=http://localhost:3000\n')
  })
  it('appends missing keys under one trailer comment, in order', () => {
    const out = mergeEnvFile(base, [
      { key: 'TAU_SANDBOX_RUNTIME', value: 'host', explicit: true },
      { key: 'TAU_SYSTEM_LOG_PROVIDER', value: 'pm2', explicit: false },
    ])
    expect(
      out.endsWith('\n# --- added by tau setup ---\nTAU_SANDBOX_RUNTIME=host\nTAU_SYSTEM_LOG_PROVIDER=pm2\n')
    ).toBe(true)
  })
  it('reuses an existing trailer instead of adding a second one', () => {
    const once = mergeEnvFile(base, [{ key: 'X', value: '1', explicit: true }])
    const twice = mergeEnvFile(once, [{ key: 'Y', value: '2', explicit: true }])
    expect(twice.split('# --- added by tau setup ---').length).toBe(2)
    expect(twice.endsWith('X=1\nY=2\n')).toBe(true)
  })
  it('quotes values containing whitespace or #', () => {
    const out = mergeEnvFile('', [
      { key: 'A', value: 'x y', explicit: true },
      { key: 'B', value: 'p#q', explicit: true },
    ])
    expect(out).toContain('A="x y"\n')
    expect(out).toContain('B="p#q"\n')
  })
  it('handles a commented-out key by appending, not by editing the comment', () => {
    const out = mergeEnvFile('# HOME_DIR=~/.tau\n', [{ key: 'HOME_DIR', value: '/data', explicit: true }])
    expect(out).toContain('# HOME_DIR=~/.tau\n')
    expect(out).toContain('\nHOME_DIR=/data\n')
  })
})

describe('renderEnvDiff', () => {
  it('lists changed keys and redacts secrets', () => {
    const after = mergeEnvFile(base, [
      { key: 'TAU_ENCRYPTION_KEY', value: 'deadbeef', explicit: false },
      { key: 'PORT', value: '3000', explicit: false },
    ])
    const lines = renderEnvDiff(base, after, ['TAU_ENCRYPTION_KEY'])
    expect(lines).toEqual(['TAU_ENCRYPTION_KEY=<redacted>', 'PORT=3000'])
  })
})
