import { expect, test } from 'bun:test'
import {
  bridgeLegacyEnv,
  EnvPrefixConflictError,
  isProtectedEnvSuffix,
  mapManagedKeyList,
  renameEnvPrefix,
  stripLegacyEnv,
  withLegacyAppAliases,
} from './legacy-env'

test('moves TAU_ to FICUS_ and deletes the legacy key', () => {
  const env: Record<string, string | undefined> = { TAU_ENCRYPTION_KEY: 'k', PATH: '/bin' }
  expect(bridgeLegacyEnv(env)).toEqual({ moved: ['TAU_ENCRYPTION_KEY'], shadowed: [], conflicts: [] })
  expect(env).toEqual({ FICUS_ENCRYPTION_KEY: 'k', PATH: '/bin' })
})
test('FICUS_ wins over TAU_ and the legacy key is still removed', () => {
  const env: Record<string, string | undefined> = { TAU_TOKEN: 'old', FICUS_TOKEN: 'new' }
  expect(bridgeLegacyEnv(env)).toEqual({ moved: [], shadowed: ['TAU_TOKEN'], conflicts: [] })
  expect(env).toEqual({ FICUS_TOKEN: 'new' })
})
test('a conflicting encryption key keeps the TAU_ value and is reported (N-I2)', () => {
  const env: Record<string, string | undefined> = { TAU_ENCRYPTION_KEY: 'real', FICUS_ENCRYPTION_KEY: 'new' }
  expect(bridgeLegacyEnv(env)).toEqual({
    moved: [],
    shadowed: ['TAU_ENCRYPTION_KEY'],
    conflicts: ['TAU_ENCRYPTION_KEY'],
  })
  expect(env).toEqual({ FICUS_ENCRYPTION_KEY: 'real' })
})
test('a conflicting password is reported; identical values are silent', () => {
  const env: Record<string, string | undefined> = {
    TAU_PASSWORD: 'a',
    FICUS_PASSWORD: 'b',
    TAU_X_PASSWORD: 's',
    FICUS_X_PASSWORD: 's',
  }
  expect(bridgeLegacyEnv(env).conflicts).toEqual(['TAU_PASSWORD'])
  expect(env).toEqual({ FICUS_PASSWORD: 'b', FICUS_X_PASSWORD: 's' })
})
test('renameEnvPrefix refuses conflicting protected values and names only the key', () => {
  const run = () => renameEnvPrefix('TAU_ENCRYPTION_KEY=secret-a\nFICUS_ENCRYPTION_KEY=secret-b\n', 'TAU_', 'FICUS_')
  expect(run).toThrow(EnvPrefixConflictError)
  expect(run).toThrow(/TAU_ENCRYPTION_KEY/)
  expect(run).not.toThrow(/secret-/)
  expect(renameEnvPrefix('TAU_PASSWORD=p\nFICUS_PASSWORD=p\n', 'TAU_', 'FICUS_')).toEqual({
    content: 'FICUS_PASSWORD=p\n',
    renamed: [],
    conflicts: [],
  })
})
test('managed secret key lists are mapped when moved', () => {
  const env: Record<string, string | undefined> = { TAU_MANAGED_SECRET_KEYS: 'TAU_PLATFORM_INSTANCE_TOKEN,SES_KEY' }
  bridgeLegacyEnv(env)
  expect(env.FICUS_MANAGED_SECRET_KEYS).toBe('FICUS_PLATFORM_INSTANCE_TOKEN,SES_KEY')
  expect(mapManagedKeyList('FICUS_A, TAU_B', 'TAU_')).toBe('TAU_A,TAU_B')
})
test('renameEnvPrefix is a hard, idempotent rename that keeps comments and order', () => {
  const src = '# c\nTAU_A=1\nB=2\nexport TAU_C="x y"\nFICUS_D=4\nTAU_D=old\nTAU_MANAGED_SECRET_KEYS=TAU_P,Q\n'
  const once = renameEnvPrefix(src, 'TAU_', 'FICUS_')
  expect(once.content).toBe(
    '# c\nFICUS_A=1\nB=2\nexport FICUS_C="x y"\nFICUS_D=4\nFICUS_MANAGED_SECRET_KEYS=FICUS_P,Q\n'
  )
  expect(once.renamed).toEqual(['TAU_A', 'TAU_C', 'TAU_MANAGED_SECRET_KEYS'])
  expect(once.conflicts).toEqual(['TAU_D'])
  expect(renameEnvPrefix(once.content, 'TAU_', 'FICUS_')).toEqual({ content: once.content, renamed: [], conflicts: [] })
})
test('stripLegacyEnv never throws and returns what it removed', () => {
  const env: Record<string, string | undefined> = { TAU_TOKEN: 'x', FICUS_TOKEN: 'y' }
  expect(stripLegacyEnv(env)).toEqual(['TAU_TOKEN'])
  expect(env).toEqual({ FICUS_TOKEN: 'y' })
})
test('withLegacyAppAliases adds TAU_ aliases only for listed keys', () => {
  expect(withLegacyAppAliases({ FICUS_APP_BASE_PATH: '/', X: '1' }, ['FICUS_APP_BASE_PATH'])).toEqual({
    FICUS_APP_BASE_PATH: '/',
    TAU_APP_BASE_PATH: '/',
    X: '1',
  })
})

test('isProtectedEnvSuffix covers encryption keys and passwords only', () => {
  expect(isProtectedEnvSuffix('ENCRYPTION_KEY')).toBe(true)
  expect(isProtectedEnvSuffix('BACKUP_ENCRYPTION_KEY')).toBe(true)
  expect(isProtectedEnvSuffix('SMTP_PASSWORD')).toBe(true)
  expect(isProtectedEnvSuffix('TOKEN')).toBe(false)
})
test('bridgeLegacyEnv maps only moved managed key lists and leaves an existing FICUS_ list alone', () => {
  const env: Record<string, string | undefined> = {
    TAU_MANAGED_SECRET_KEYS: 'TAU_A',
    FICUS_MANAGED_SECRET_KEYS: 'FICUS_B',
  }
  expect(bridgeLegacyEnv(env)).toEqual({ moved: [], shadowed: ['TAU_MANAGED_SECRET_KEYS'], conflicts: [] })
  expect(env).toEqual({ FICUS_MANAGED_SECRET_KEYS: 'FICUS_B' })
})
test('renameEnvPrefix names the source key in the reverse direction and never a value', () => {
  let error: unknown
  try {
    renameEnvPrefix('FICUS_DB_PASSWORD="pw-first"\nTAU_DB_PASSWORD=pw-second\n', 'FICUS_', 'TAU_')
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(EnvPrefixConflictError)
  expect((error as EnvPrefixConflictError).keys).toEqual(['FICUS_DB_PASSWORD'])
  expect((error as Error).message).not.toMatch(/pw-/)
})
test('renameEnvPrefix treats quoting as the same value and sees a later FICUS_ line', () => {
  expect(renameEnvPrefix('TAU_ENCRYPTION_KEY="k"\nFICUS_ENCRYPTION_KEY=k\n', 'TAU_', 'FICUS_')).toEqual({
    content: 'FICUS_ENCRYPTION_KEY=k\n',
    renamed: [],
    conflicts: [],
  })
  expect(renameEnvPrefix('TAU_MANAGED_SECRET_KEYS="TAU_A, B"\n', 'TAU_', 'FICUS_').content).toBe(
    'FICUS_MANAGED_SECRET_KEYS="FICUS_A,B"\n'
  )
})
