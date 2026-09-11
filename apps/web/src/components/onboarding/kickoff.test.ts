import { describe, expect, test } from 'bun:test'
import { composeKickoff } from './kickoff'

describe('composeKickoff', () => {
  test('with repos: instructs cloning each URL into the workspace, exploring, and replying with a summary + suggested first tasks', () => {
    const message = composeKickoff(['https://github.com/acme/api', 'https://github.com/acme/web'])

    expect(message).toContain('https://github.com/acme/api')
    expect(message).toContain('https://github.com/acme/web')
    expect(message.toLowerCase()).toContain('clone')
    expect(message.toLowerCase()).toContain('workspace')
    expect(message.toLowerCase()).toContain('explore')
    expect(message.toLowerCase()).toContain('summary')
    expect(message.toLowerCase()).toContain('suggested first tasks')
  })

  test('without repos: a lighter introduce-yourself template with no cloning instruction', () => {
    const message = composeKickoff([])

    expect(message.toLowerCase()).not.toContain('clone')
    expect(message.toLowerCase()).toContain('introduce')
  })

  test('URLs appear verbatim, aside from surrounding-whitespace trimming', () => {
    const message = composeKickoff([' https://github.com/acme/api?ref=main#readme '])

    expect(message).toContain('https://github.com/acme/api?ref=main#readme')
  })

  test('duplicate URLs are not silently de-duplicated', () => {
    const message = composeKickoff(['https://github.com/acme/api', 'https://github.com/acme/api'])

    const occurrences = message.split('https://github.com/acme/api').length - 1
    expect(occurrences).toBe(2)
  })

  test('single repo uses singular phrasing', () => {
    const message = composeKickoff(['https://github.com/acme/api'])

    expect(message.toLowerCase()).toContain('repository')
    expect(message.toLowerCase()).not.toContain('repositories')
  })
})
