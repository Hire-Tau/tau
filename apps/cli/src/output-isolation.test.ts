import { expect, mock, test } from 'bun:test'
import { isJsonMode, isQuietMode } from './output'

test('a command can opt into JSON and quiet output', () => {
  ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
  ;(isQuietMode as ReturnType<typeof mock>).mockReturnValue(true)
  expect(isJsonMode()).toBe(true)
  expect(isQuietMode()).toBe(true)
})

test('the next command starts with default output modes', () => {
  // Removing the preload reset makes this test fail, even without other files.
  expect(isJsonMode()).toBe(false)
  expect(isQuietMode()).toBe(false)
})
