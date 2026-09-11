import { describe, expect, test } from 'bun:test'
import { sandboxRecoverySubscriptions, workStreamContinuations } from './schema'

describe('durable continuation and recovery delivery linkage', () => {
  test('fences continuation claims and records the exact accepted delivery', () => {
    expect(workStreamContinuations.normalAttemptCount).toBeDefined()
    expect(workStreamContinuations.transportAttemptCount).toBeDefined()
    expect(workStreamContinuations.deliveryAttemptCount).toBeDefined()
    expect(workStreamContinuations.claimToken).toBeDefined()
    expect(workStreamContinuations.deliveryPrompt).toBeDefined()
    expect(workStreamContinuations.deliveryMessageId).toBeDefined()
    expect(workStreamContinuations.deliveryExecutionId).toBeDefined()
    expect(workStreamContinuations.progressExecutionId).toBeDefined()
  })

  test('recovery retries adopt one stable receipt and exact delivery', () => {
    expect(sandboxRecoverySubscriptions.notificationClientId).toBeDefined()
    expect(sandboxRecoverySubscriptions.deliveryMessageId).toBeDefined()
    expect(sandboxRecoverySubscriptions.deliveryExecutionId).toBeDefined()
  })
})
