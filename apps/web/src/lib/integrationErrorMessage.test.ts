import { expect, test } from 'bun:test'
import { ApiError } from '../api/client'
import { integrationErrorMessage } from './integrationErrorMessage'

const fallback = "Couldn't start GitHub login."

test('shows the server message for typed provider failures', () => {
  const error = new ApiError(502, 'API error: 502: unreachable', {
    error: "GitHub couldn't be reached from this computer. Check the network connection and retry.",
    code: 'provider_unavailable',
  })
  expect(integrationErrorMessage(error, fallback)).toBe(
    "GitHub couldn't be reached from this computer. Check the network connection and retry."
  )
})

test('translates known authorization flow codes', () => {
  const error = new ApiError(400, 'API error: 400: oauth_app_unconfigured', { error: 'oauth_app_unconfigured' })
  expect(integrationErrorMessage(error, fallback)).toContain('No GitHub App is configured')
})

test('keeps unknown codes visible beside the fallback', () => {
  const error = new ApiError(400, 'API error: 400: unsafe_return_target', {
    error: 'unsafe_return_target',
    code: 'unsafe_return_target',
  })
  expect(integrationErrorMessage(error, fallback)).toBe(`${fallback} (unsafe_return_target)`)
})

test('falls back without a JSON body or for non-API errors', () => {
  expect(integrationErrorMessage(new ApiError(500, 'API error: 500'), fallback)).toBe(fallback)
  expect(integrationErrorMessage(new Error('network down'), fallback)).toBe(fallback)
  expect(integrationErrorMessage('rejected', fallback)).toBe(fallback)
})
