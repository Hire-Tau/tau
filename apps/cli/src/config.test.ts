import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { config, isAgentContext, resolveAuth, setSelectedBackend } from './config'
import { loadEnv } from './env'

const tempDirs: string[] = []

/** An auth store holding a HUMAN login — what an agent shell must never reach for. */
async function makeOperatorAuthStore() {
  const dir = await mkdtemp(join(tmpdir(), 'tau-agent-context-'))
  tempDirs.push(dir)
  const authStore = join(dir, 'auth.json')
  await writeFile(
    authStore,
    JSON.stringify({
      active: 'cloud',
      backends: { cloud: { apiUrl: 'https://cloud.example.com', password: 'operator-token' } },
    })
  )
  return authStore
}

function clearEnv() {
  delete process.env.TAU_WEBHOOK_CONTEXT
  delete process.env.TAU_AGENT_CONTEXT
  delete process.env.TAU_AGENT_ID
  delete process.env.TAU_API_URL
  delete process.env.TAU_TOKEN
  delete process.env.TAU_PASSWORD
  delete process.env.TAU_AUTH_STORE
}

beforeEach(clearEnv)

afterEach(async () => {
  setSelectedBackend(undefined)
  clearEnv()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('agent context', () => {
  it('is off unless TAU_AGENT_CONTEXT is exactly 1', () => {
    expect(isAgentContext()).toBe(false)
    process.env.TAU_AGENT_CONTEXT = '0'
    expect(isAgentContext()).toBe(false)
    process.env.TAU_AGENT_CONTEXT = '1'
    expect(isAgentContext()).toBe(true)
  })

  it('resolves from the env and never consults the auth store', async () => {
    process.env.TAU_AUTH_STORE = await makeOperatorAuthStore()
    process.env.TAU_AGENT_CONTEXT = '1'
    process.env.TAU_AGENT_ID = 'agent-1'
    process.env.TAU_API_URL = 'http://127.0.0.1:3000'
    process.env.TAU_TOKEN = 'agent-token'

    expect(config.apiUrl).toBe('http://127.0.0.1:3000')
    expect(config.password).toBe('agent-token')
    expect(resolveAuth()).toEqual({
      source: 'agent-context',
      apiUrl: 'http://127.0.0.1:3000',
      agentId: 'agent-1',
      authenticated: true,
    })
  })

  it('uses the injected values even when a .env in the cwd carries the same ones', async () => {
    // Bun auto-loads ./.env before any CLI code runs, so a value identical to the
    // file's reads as "implicit" to the dotenv heuristic — which used to discard a
    // perfectly valid injected identity and fall through to the operator's store.
    // loadEnv's bookkeeping is module-level and outlives this file, so the values
    // are unique to this test: a value another test also uses would be recorded as
    // dotenv-implicit there too and change ITS resolution (cross-file leakage).
    const dir = await mkdtemp(join(tmpdir(), 'tau-agent-dotenv-'))
    tempDirs.push(dir)
    await writeFile(join(dir, '.env'), 'TAU_API_URL=http://127.0.0.1:39991\nTAU_TOKEN=agent-token-shadowed-by-dotenv\n')
    process.env.TAU_API_URL = 'http://127.0.0.1:39991'
    process.env.TAU_TOKEN = 'agent-token-shadowed-by-dotenv'
    loadEnv({ cwd: dir })
    process.env.TAU_AUTH_STORE = await makeOperatorAuthStore()
    process.env.TAU_AGENT_CONTEXT = '1'

    expect(config.apiUrl).toBe('http://127.0.0.1:39991')
    expect(config.password).toBe('agent-token-shadowed-by-dotenv')
  })

  it('throws naming TAU_API_URL when the instance is not injected', () => {
    process.env.TAU_AGENT_CONTEXT = '1'
    process.env.TAU_TOKEN = 'agent-token'

    expect(() => config.apiUrl).toThrow(/TAU_API_URL/)
  })

  it('reports rather than throws for an incomplete agent shell, so it can be diagnosed', async () => {
    process.env.TAU_AUTH_STORE = await makeOperatorAuthStore()
    process.env.TAU_AGENT_CONTEXT = '1'
    process.env.TAU_AGENT_ID = 'agent-1'

    const resolved = resolveAuth()
    expect(resolved.source).toBe('agent-context')
    expect(resolved.missing).toEqual(['TAU_API_URL', 'TAU_TOKEN'])
    expect(resolved.authenticated).toBe(false)
    // Still no leak to the operator's login.
    expect(resolved.apiUrl).toBe('')
  })

  it('throws rather than falling back to a human login when the agent token is absent', async () => {
    process.env.TAU_AUTH_STORE = await makeOperatorAuthStore()
    process.env.TAU_AGENT_CONTEXT = '1'
    process.env.TAU_API_URL = 'http://127.0.0.1:3000'

    expect(() => config.password).toThrow(/TAU_TOKEN/)
    expect(() => config.password).toThrow(/human login/)
  })

  it('refuses --backend, which selects a human login', async () => {
    process.env.TAU_AUTH_STORE = await makeOperatorAuthStore()
    process.env.TAU_AGENT_CONTEXT = '1'
    process.env.TAU_API_URL = 'http://127.0.0.1:3000'
    process.env.TAU_TOKEN = 'agent-token'
    setSelectedBackend('cloud')

    expect(() => config.apiUrl).toThrow(/--backend/)
    expect(() => config.password).toThrow(/injected identity/)
    expect(() => resolveAuth()).toThrow(/--backend/)
  })

  it('leaves resolution outside agent context untouched', async () => {
    process.env.TAU_AUTH_STORE = await makeOperatorAuthStore()

    expect(config.apiUrl).toBe('https://cloud.example.com')
    expect(config.password).toBe('operator-token')
    expect(resolveAuth()).toMatchObject({ source: 'auth-store', label: 'cloud' })
  })
})

describe('webhook context', () => {
  it('keeps the injected token and instance together even when dotenv matches an operator backend', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tau-webhook-dotenv-'))
    tempDirs.push(dir)
    await writeFile(
      join(dir, '.env'),
      'TAU_API_URL=http://127.0.0.1:39992\nTAU_TOKEN=webhook-token-shadowed-by-dotenv\n'
    )
    process.env.TAU_API_URL = 'http://127.0.0.1:39992'
    process.env.TAU_TOKEN = 'webhook-token-shadowed-by-dotenv'
    loadEnv({ cwd: dir })
    process.env.TAU_AUTH_STORE = await makeOperatorAuthStore()
    process.env.TAU_WEBHOOK_CONTEXT = '1'

    expect(config.apiUrl).toBe('http://127.0.0.1:39992')
    expect(config.password).toBe('webhook-token-shadowed-by-dotenv')
    expect(resolveAuth()).toEqual({ source: 'webhook-context', apiUrl: 'http://127.0.0.1:39992', authenticated: true })
  })

  it('fails closed when a webhook credential or instance is missing', async () => {
    process.env.TAU_AUTH_STORE = await makeOperatorAuthStore()
    process.env.TAU_WEBHOOK_CONTEXT = '1'
    expect(() => config.apiUrl).toThrow(/TAU_API_URL/)
    expect(() => config.password).toThrow(/credential/)
    expect(resolveAuth()).toMatchObject({ source: 'webhook-context', apiUrl: '', authenticated: false })
  })

  it('supports the injected bootstrap password without selecting a human login', async () => {
    process.env.TAU_AUTH_STORE = await makeOperatorAuthStore()
    process.env.TAU_WEBHOOK_CONTEXT = '1'
    process.env.TAU_API_URL = 'http://127.0.0.1:39993'
    process.env.TAU_PASSWORD = 'bootstrap-password'
    expect(config.password).toBe('bootstrap-password')
    expect(resolveAuth().authenticated).toBe(true)
    setSelectedBackend('cloud')
    expect(() => config.apiUrl).toThrow(/--backend/)
    expect(() => config.password).toThrow(/--backend/)
    expect(() => resolveAuth()).toThrow(/--backend/)
  })
})
