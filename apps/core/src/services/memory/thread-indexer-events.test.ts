import { describe, expect, it, beforeEach } from 'bun:test'
import { eventEmitter } from '../../lib/infra/event-emitter'
import {
  _resetThreadIndexerEvents,
  isThreadIndexerEventsRegistered,
  registerThreadIndexerEvents,
} from './thread-indexer-events'

describe('thread indexer events', () => {
  beforeEach(() => {
    eventEmitter.removeAllListeners()
    _resetThreadIndexerEvents()
  })

  it('does not register handlers while agent thread indexing is temporarily disabled', () => {
    registerThreadIndexerEvents()

    expect(isThreadIndexerEventsRegistered()).toBe(false)
  })
})
