import { describe, test, expect } from 'bun:test'
import { resolveSandboxStyle, sandboxPollInterval, SANDBOX_STATUS_POLL_MS } from './sandboxStatusStyles'

describe('sandboxPollInterval (live-events safety-net)', () => {
  test('returns the slow safety-net interval for every state', () => {
    expect(sandboxPollInterval(undefined)).toBe(SANDBOX_STATUS_POLL_MS)
    expect(sandboxPollInterval({ status: 'not_found' } as any)).toBe(SANDBOX_STATUS_POLL_MS)
    expect(sandboxPollInterval({ status: 'pending' } as any)).toBe(SANDBOX_STATUS_POLL_MS)
    expect(sandboxPollInterval({ status: 'starting' } as any)).toBe(SANDBOX_STATUS_POLL_MS)
    expect(sandboxPollInterval({ status: 'terminating' } as any)).toBe(SANDBOX_STATUS_POLL_MS)
    expect(sandboxPollInterval({ status: 'running', devboxReady: false } as any)).toBe(SANDBOX_STATUS_POLL_MS)
    expect(sandboxPollInterval({ status: 'running', devboxReady: true } as any)).toBe(SANDBOX_STATUS_POLL_MS)
  })

  test('the safety-net interval is 30s', () => {
    expect(SANDBOX_STATUS_POLL_MS).toBe(30_000)
  })
})

describe('toolchain status styles', () => {
  test('shows managed provisioning progress and failure', () => {
    expect(
      resolveSandboxStyle({ status: 'running', toolchain: { status: 'installing', desiredFingerprint: 'x' } }).config
        .label
    ).toBe('Installing packages')
    expect(
      resolveSandboxStyle({ status: 'running', toolchain: { status: 'running_setup', desiredFingerprint: 'x' } }).config
        .label
    ).toBe('Running setup')
    expect(
      resolveSandboxStyle({
        status: 'running',
        toolchain: { status: 'failed', desiredFingerprint: 'x', reason: 'Package installation failed' },
      }).reason
    ).toBe(' (Package installation failed)')
  })

  test('keeps every non-running physical state and reason primary with toolchain diagnostics secondary', () => {
    expect(
      resolveSandboxStyle({
        status: 'not_found',
        reason: 'sandbox missing',
        toolchain: { status: 'pending', desiredFingerprint: 'x' },
      })
    ).toEqual({
      config: expect.objectContaining({ label: 'Not running' }),
      reason: ' (sandbox missing); Toolchain pending',
    })
    expect(
      resolveSandboxStyle({
        status: 'failed',
        reason: 'OOMKilled',
        toolchain: { status: 'installing', desiredFingerprint: 'x' },
      })
    ).toEqual({ config: expect.objectContaining({ label: 'Failed' }), reason: ' (OOMKilled); Installing packages' })
    expect(
      resolveSandboxStyle({
        status: 'starting',
        reason: 'box is provisioning',
        toolchain: { status: 'failed', desiredFingerprint: 'x', reason: 'install failed' },
      })
    ).toEqual({
      config: expect.objectContaining({ label: 'Starting' }),
      reason: ' (box is provisioning); Toolchain failed (install failed)',
    })
  })
})

describe('semantic sandbox styling', () => {
  test('uses attention amber for transition and degraded states', () => {
    expect(resolveSandboxStyle({ status: 'starting' } as any).config).toEqual(
      expect.objectContaining({ color: expect.stringContaining('amber'), dotColor: 'bg-amber-500' })
    )
    const degraded = resolveSandboxStyle({
      status: 'running',
      runtime: 'vm',
      readiness: 'ready_degraded',
      degradation: { reasons: ['bashrc_unavailable'], attemptCount: 2 },
    })
    expect(degraded.config.label).toBe('Running — degraded')
    expect(degraded.config.color).toContain('amber')
    expect(degraded.config.dotColor).toBe('bg-amber-500')
  })

  test('uses progress, success, and danger roles for setup, healthy, and failed states', () => {
    expect(
      resolveSandboxStyle({ status: 'running', toolchain: { status: 'installing', desiredFingerprint: 'x' } }).config
        .dotColor
    ).toBe('bg-blue-500')
    expect(
      resolveSandboxStyle({ status: 'running', toolchain: { status: 'running_setup', desiredFingerprint: 'x' } }).config
        .dotColor
    ).toBe('bg-blue-500')
    expect(resolveSandboxStyle({ status: 'running', devboxReady: true } as any).config.dotColor).toBe('bg-green-500')
    expect(resolveSandboxStyle({ status: 'failed' } as any).config.dotColor).toBe('bg-red-500')
  })

  test('uses the accepted solid neutral marker for non-running states', () => {
    expect(resolveSandboxStyle({ status: 'not_found' } as any).config.dotColor).toBe('bg-gray-500')
    expect(resolveSandboxStyle({ status: 'succeeded' } as any).config.dotColor).toBe('bg-gray-500')
    expect(resolveSandboxStyle({ status: 'unknown' } as any).config.dotColor).toBe('bg-gray-500')
  })
})
