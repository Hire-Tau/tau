import { describe, expect, test } from 'bun:test'
import {
  OAUTH_BROKER_SCOPES,
  SAFE_CODE_PATTERN,
  brokerCallbackQuery,
  brokerFailureResponse,
  brokerRedeemRequest,
  brokerRedeemResponse,
  brokerRefreshRequest,
  brokerRefreshResponse,
  brokerRevokeRequest,
  brokerRevokeResponse,
  brokerStartRequest,
  brokerStartResponse,
} from './protocol'

const flow = crypto.randomUUID()
const tokens = { accessToken: 'access', refreshToken: 'refresh', expiresAt: '2030-01-01T00:00:00.000Z' }

describe('OAuth broker protocol', () => {
  test('declares the closed set of broker scopes and safe boundary codes', () => {
    expect(OAUTH_BROKER_SCOPES).toEqual([
      'integrations.oauth:start',
      'integrations.oauth:redeem',
      'integrations.oauth:refresh',
      'integrations.oauth:revoke',
    ])
    expect(SAFE_CODE_PATTERN.test('provider_timeout')).toBe(true)
    expect(SAFE_CODE_PATTERN.test('Bearer secret')).toBe(false)
    expect(SAFE_CODE_PATTERN.test('A'.repeat(65))).toBe(false)
  })

  test('start request rejects unknown keys, bad uuid, and bad intent', () => {
    expect(brokerStartRequest.safeParse({ localFlowId: flow, intent: 'connect' }).success).toBe(true)
    expect(brokerStartRequest.safeParse({ localFlowId: flow, intent: 'connect', tenantId: flow }).success).toBe(true)
    expect(brokerStartRequest.safeParse({ localFlowId: flow, intent: 'connect', extra: 1 }).success).toBe(false)
    expect(brokerStartRequest.safeParse({ localFlowId: 'nope', intent: 'connect' }).success).toBe(false)
    expect(brokerStartRequest.safeParse({ localFlowId: flow, intent: 'delete' }).success).toBe(false)
  })

  test('callback query requires state and exactly one provider outcome', () => {
    const state = 'S'.repeat(43)
    expect(brokerCallbackQuery.safeParse({ state, code: 'provider-code' }).success).toBe(true)
    expect(brokerCallbackQuery.safeParse({ state, error: 'access_denied' }).success).toBe(true)
    expect(brokerCallbackQuery.safeParse({ state }).success).toBe(false)
    expect(brokerCallbackQuery.safeParse({ state, code: 'c', error: 'denied' }).success).toBe(false)
    expect(brokerCallbackQuery.safeParse({ state: 'short', error: 'denied' }).success).toBe(false)
    expect(brokerCallbackQuery.safeParse({ state, error: 'denied', extra: true }).success).toBe(false)
  })

  test('failure responses carry only a sanitized code', () => {
    expect(brokerFailureResponse.safeParse({ code: 'provider_timeout' }).success).toBe(true)
    expect(brokerFailureResponse.safeParse({ code: 'Bearer secret' }).success).toBe(false)
    expect(brokerFailureResponse.safeParse({ code: 'provider_timeout', detail: 'raw' }).success).toBe(false)
  })

  test('start response requires an HTTPS authorization URL, transaction uuid, and ISO expiry', () => {
    const valid = {
      authorizationUrl: 'https://api.notion.com/v1/oauth/authorize',
      transactionId: flow,
      expiresAt: '2030-01-01T00:00:00.000Z',
    }
    expect(brokerStartResponse.safeParse(valid).success).toBe(true)
    expect(brokerStartResponse.safeParse({ ...valid, authorizationUrl: 'not a url' }).success).toBe(false)
    expect(
      brokerStartResponse.safeParse({ ...valid, authorizationUrl: 'https://user:pass@api.notion.com' }).success
    ).toBe(false)
    expect(brokerStartResponse.safeParse({ ...valid, expiresAt: 'tomorrow' }).success).toBe(false)
    expect(brokerStartResponse.safeParse({ ...valid, expiresAt: '2030-01-01T00:00:00Z' }).success).toBe(true)
    expect(brokerStartResponse.safeParse({ ...valid, extra: true }).success).toBe(false)
  })

  test('redeem schemas enforce handle, flow, operation key, and credential bounds', () => {
    const request = { handle: 'H'.repeat(43), localFlowId: flow, operationKey: 'redeem-key' }
    expect(brokerRedeemRequest.safeParse(request).success).toBe(true)
    expect(brokerRedeemRequest.safeParse({ ...request, handle: 'short' }).success).toBe(false)
    expect(brokerRedeemRequest.safeParse({ ...request, operationKey: 'k'.repeat(201) }).success).toBe(false)
    const response = { configuration: {}, credential: tokens, displayName: 'Workspace' }
    expect(brokerRedeemResponse.safeParse(response).success).toBe(true)
    expect(brokerRedeemResponse.safeParse({ ...response, displayName: '' }).success).toBe(false)
    expect(brokerRedeemResponse.safeParse({ ...response, credential: { ...tokens, extra: true } }).success).toBe(false)
  })

  test('a 16385-character token is rejected', () => {
    expect(
      brokerRefreshRequest.safeParse({
        refreshToken: 'x'.repeat(16_385),
        operationKey: 'k',
        connectionFingerprint: 'a'.repeat(64),
      }).success
    ).toBe(false)
  })

  test('refresh schemas reject malformed fingerprints, timestamps, and extra keys', () => {
    const request = { refreshToken: 'r', operationKey: 'k', connectionFingerprint: 'a'.repeat(64) }
    expect(brokerRefreshRequest.safeParse(request).success).toBe(true)
    expect(brokerRefreshRequest.safeParse({ ...request, connectionFingerprint: 'A'.repeat(64) }).success).toBe(false)
    expect(brokerRefreshRequest.safeParse({ ...request, extra: true }).success).toBe(false)
    const response = { ...tokens, configuration: {} }
    expect(brokerRefreshResponse.safeParse(response).success).toBe(true)
    expect(brokerRefreshResponse.safeParse({ ...response, expiresAt: 'soon' }).success).toBe(false)
    expect(brokerRefreshResponse.safeParse({ ...response, expiresAt: '2030-01-01T00:00:00Z' }).success).toBe(false)
  })

  test('revoke schemas bound the token and require literal success', () => {
    expect(brokerRevokeRequest.safeParse({ token: 'a', operationKey: 'k' }).success).toBe(true)
    expect(brokerRevokeRequest.safeParse({ token: '', operationKey: 'k' }).success).toBe(false)
    expect(brokerRevokeRequest.safeParse({ token: 'a', operationKey: '' }).success).toBe(false)
    expect(brokerRevokeResponse.safeParse({ revoked: true }).success).toBe(true)
    expect(brokerRevokeResponse.safeParse({ revoked: false }).success).toBe(false)
  })
})
