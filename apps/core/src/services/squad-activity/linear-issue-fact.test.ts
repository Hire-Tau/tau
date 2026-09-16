import { describe, expect, it } from 'bun:test'
import {
  describeLinearIssueFact,
  extractLinearIssueDispatchFact,
  isLinearIssueDispatchFact,
  type LinearIssueDispatchFact,
} from './linear-issue-fact'

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/

const issueData = (overrides: Record<string, unknown> = {}) => ({
  id: 'issue-1111',
  number: 12,
  identifier: 'ENG-12',
  title: 'Ship the tracked issue',
  url: 'https://linear.app/acme/issue/ENG-12/ship-the-tracked-issue',
  teamId: 'team-1111',
  team: { id: 'team-1111', key: 'ENG' },
  state: { id: 'state-2', name: 'In Progress', type: 'started' },
  assigneeId: null,
  labelIds: ['label-1'],
  labels: [{ id: 'label-1', name: 'bug' }],
  createdAt: '2026-09-15T10:00:00Z',
  updatedAt: '2026-09-16T10:00:00Z',
  ...overrides,
})

const issueEvent = (
  updatedFrom: Record<string, unknown>,
  data: Record<string, unknown> = {},
  payload: Record<string, unknown> = {},
  metadata: Record<string, unknown> = { providerDeliveryId: 'delivery-1' }
) =>
  ({
    type: 'Issue',
    payload: {
      action: 'update',
      type: 'Issue',
      data: issueData(data),
      updatedFrom,
      actor: { id: 'actor-1', name: 'Ada' },
      webhookTimestamp: Date.parse('2026-09-16T12:00:00Z'),
      ...payload,
    },
    metadata: { source: 'webhook', ...metadata },
  }) as any

const commentEvent = (action: string, data: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) =>
  ({
    type: 'Comment',
    payload: {
      action,
      type: 'Comment',
      data: {
        id: 'comment-1',
        body: 'Looks good',
        issueId: 'issue-1111',
        issue: { id: 'issue-1111', title: 'Ship the tracked issue', identifier: 'ENG-12', number: 12 },
        userId: 'user-9',
        url: 'https://linear.app/acme/issue/ENG-12#comment-comment-1',
        createdAt: '2026-09-16T11:00:00Z',
        updatedAt: '2026-09-16T11:30:00Z',
        ...data,
      },
      webhookTimestamp: Date.parse('2026-09-16T12:00:00Z'),
      ...payload,
    },
    metadata: { source: 'webhook', providerDeliveryId: 'delivery-2' },
  }) as any

describe('Linear issue dispatch fact', () => {
  it('extracts a state transition with its new state as the dedupe-significant detail', () => {
    expect(extractLinearIssueDispatchFact('linear', issueEvent({ stateId: 'state-1' }))).toEqual({
      eventType: 'Issue',
      action: 'state',
      occurredAt: '2026-09-16T10:00:00.000Z',
      actorId: 'actor-1',
      issueId: 'issue-1111',
      identifier: 'ENG-12',
      teamKey: 'eng',
      number: 12,
      title: 'Ship the tracked issue',
      stateType: 'started',
      detail: 'In Progress',
      nativeId: 'issue-1111',
      providerDeliveryId: 'delivery-1',
      logicalRowId: expect.stringMatching(UUID_SHAPE),
      url: 'https://linear.app/acme/issue/ENG-12/ship-the-tracked-issue',
    })
  })

  it('names the assignee on assignment and the prior assignee on unassignment', () => {
    const assigned = extractLinearIssueDispatchFact(
      'linear',
      issueEvent({ assigneeId: null }, { assigneeId: 'user-2' })
    )!
    expect([assigned.action, assigned.detail]).toEqual(['assigned', 'user-2'])
    const unassigned = extractLinearIssueDispatchFact(
      'linear',
      issueEvent({ assigneeId: 'user-2' }, { assigneeId: null })
    )!
    expect([unassigned.action, unassigned.detail]).toEqual(['unassigned', 'user-2'])
    expect(unassigned.logicalRowId).not.toBe(assigned.logicalRowId)
  })

  it('resolves one action per update by key precedence, newest coordinates first', () => {
    const action = (updatedFrom: Record<string, unknown>, data: Record<string, unknown> = {}) =>
      extractLinearIssueDispatchFact('linear', issueEvent(updatedFrom, data))?.action
    expect(action({ assigneeId: null, stateId: 's', title: 't', labelIds: [] }, { assigneeId: 'user-2' })).toBe(
      'assigned'
    )
    expect(action({ stateId: 's', title: 't', labelIds: [] })).toBe('state')
    expect(action({ title: 't', labelIds: [] })).toBe('title')
    expect(action({ labelIds: ['label-0'] })).toBe('labels')
    expect(action({ description: 'old' })).toBe('updated')
    expect(action({})).toBe('updated')
  })

  it('joins the issue labels as the detail of a label change and leaves plain updates detail-less', () => {
    expect(
      extractLinearIssueDispatchFact(
        'linear',
        issueEvent(
          { labelIds: [] },
          { labels: [{ id: 'label-1', name: 'bug' }, { id: 'label-2', name: 'urgent' }, { name: '' }] }
        )
      )?.detail
    ).toBe('bug, urgent')
    expect(extractLinearIssueDispatchFact('linear', issueEvent({ description: 'old' }))?.detail).toBeNull()
  })

  it('yields no fact for issue creation or removal', () => {
    expect(extractLinearIssueDispatchFact('linear', issueEvent({}, {}, { action: 'create' }))).toBeNull()
    expect(extractLinearIssueDispatchFact('linear', issueEvent({}, {}, { action: 'remove' }))).toBeNull()
  })

  it('extracts comments and their edits as separate facts keyed by the comment', () => {
    const comment = extractLinearIssueDispatchFact('linear', commentEvent('create'))!
    expect(comment).toEqual({
      eventType: 'Comment',
      action: 'comment',
      occurredAt: '2026-09-16T11:00:00.000Z',
      actorId: 'user-9',
      issueId: 'issue-1111',
      identifier: 'ENG-12',
      teamKey: null,
      number: 12,
      title: 'Ship the tracked issue',
      stateType: null,
      detail: null,
      nativeId: 'comment-1',
      providerDeliveryId: 'delivery-2',
      logicalRowId: expect.stringMatching(UUID_SHAPE),
      url: 'https://linear.app/acme/issue/ENG-12#comment-comment-1',
    })
    const edited = extractLinearIssueDispatchFact('linear', commentEvent('update'))!
    expect([edited.action, edited.occurredAt]).toEqual(['comment-edited', '2026-09-16T11:30:00.000Z'])
    expect(edited.logicalRowId).not.toBe(comment.logicalRowId)
    // A later edit of the same comment is its own fact, not a duplicate of the first.
    expect(
      extractLinearIssueDispatchFact('linear', commentEvent('update', { updatedAt: '2026-09-16T11:45:00Z' }))!
        .logicalRowId
    ).not.toBe(edited.logicalRowId)
    // Two comments on one issue at one instant stay distinct through the comment id.
    expect(
      extractLinearIssueDispatchFact('linear', commentEvent('create', { id: 'comment-2' }))!.logicalRowId
    ).not.toBe(comment.logicalRowId)
  })

  it('takes the issue identity from the nested issue when a comment omits issueId', () => {
    const comment = extractLinearIssueDispatchFact('linear', commentEvent('create', { issueId: undefined }))!
    expect(comment.issueId).toBe('issue-1111')
    expect(
      extractLinearIssueDispatchFact('linear', commentEvent('create', { issueId: undefined, issue: {} }))
    ).toBeNull()
  })

  it('redeliveries of one event share a row id; a different occurrence does not', () => {
    const first = extractLinearIssueDispatchFact('linear', issueEvent({ stateId: 'state-1' }))!
    const retry = extractLinearIssueDispatchFact(
      'linear',
      issueEvent({ stateId: 'state-1' }, {}, {}, { providerDeliveryId: 'delivery-77' })
    )!
    expect(retry.logicalRowId).toBe(first.logicalRowId)
    expect(retry.providerDeliveryId).toBe('delivery-77')
    expect(
      extractLinearIssueDispatchFact(
        'linear',
        issueEvent({ stateId: 'state-1' }, { updatedAt: '2026-09-16T10:05:00Z' })
      )!.logicalRowId
    ).not.toBe(first.logicalRowId)
  })

  it('rejects payloads that are not a supported, self-consistent Linear issue delivery', () => {
    expect(extractLinearIssueDispatchFact('github', issueEvent({ stateId: 'state-1' }))).toBeNull()
    expect(
      extractLinearIssueDispatchFact('linear', { type: 'Project', payload: { action: 'update', data: {} } } as any)
    ).toBeNull()
    // The signature covers the body only; a mutated `Linear-Event` header cannot re-type a delivery.
    expect(extractLinearIssueDispatchFact('linear', issueEvent({ stateId: 's' }, {}, { type: 'Comment' }))).toBeNull()
    expect(extractLinearIssueDispatchFact('linear', { type: 'Issue', payload: {} } as any)).toBeNull()
    expect(extractLinearIssueDispatchFact('linear', issueEvent({ stateId: 's' }, { id: '' }))).toBeNull()
    expect(extractLinearIssueDispatchFact('linear', issueEvent({ stateId: 's' }, { id: 42 }))).toBeNull()
  })

  it('falls back to the delivery timestamp, and yields nothing without any usable time', () => {
    expect(
      extractLinearIssueDispatchFact('linear', issueEvent({ stateId: 's' }, { updatedAt: 'not-a-time' }))?.occurredAt
    ).toBe('2026-09-16T12:00:00.000Z')
    expect(
      extractLinearIssueDispatchFact(
        'linear',
        issueEvent({ stateId: 's' }, { updatedAt: undefined }, { webhookTimestamp: 'later' })
      )
    ).toBeNull()
  })

  it('keeps display fields bounded and optional coordinates absent rather than wrong', () => {
    const fact = extractLinearIssueDispatchFact(
      'linear',
      issueEvent(
        { stateId: 's' },
        {
          title: 'x'.repeat(400),
          identifier: undefined,
          number: 0,
          team: { id: 'team-1111' },
          state: { id: 'state-2' },
          url: 'javascript:alert(1)',
        }
      )
    )!
    expect(fact.title).toHaveLength(200)
    expect([fact.identifier, fact.teamKey, fact.number, fact.stateType, fact.detail, fact.url]).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ])
    expect(isLinearIssueDispatchFact(fact)).toBe(true)
  })

  it('revalidates a stored fact against its own coordinates', () => {
    const fact = extractLinearIssueDispatchFact('linear', issueEvent({ stateId: 'state-1' }))!
    expect(isLinearIssueDispatchFact(fact)).toBe(true)
    expect(isLinearIssueDispatchFact({ ...fact, logicalRowId: crypto.randomUUID() })).toBe(false)
    // Every identity field is covered by the row id, so tampering with one invalidates the fact.
    expect(isLinearIssueDispatchFact({ ...fact, detail: 'Done' })).toBe(false)
    expect(isLinearIssueDispatchFact({ ...fact, issueId: 'issue-2222' })).toBe(false)
    expect(isLinearIssueDispatchFact({ ...fact, occurredAt: '2026-09-16T10:00:01.000Z' })).toBe(false)
    expect(isLinearIssueDispatchFact({ ...fact, action: 'exploded' })).toBe(false)
    expect(isLinearIssueDispatchFact({ ...fact, eventType: 'Comment' })).toBe(false)
    expect(isLinearIssueDispatchFact({ ...fact, teamKey: 'ENG' })).toBe(false)
    expect(isLinearIssueDispatchFact({ ...fact, title: 'x'.repeat(201) })).toBe(false)
    expect(isLinearIssueDispatchFact(null)).toBe(false)
    expect(isLinearIssueDispatchFact('fact')).toBe(false)
  })

  it('describes every action in the feed voice', () => {
    const describe_ = (action: LinearIssueDispatchFact['action'], detail: string | null = null) =>
      describeLinearIssueFact({ action, detail })
    expect([
      describe_('assigned'),
      describe_('unassigned'),
      describe_('state', 'In Progress'),
      describe_('title'),
      describe_('labels', 'bug'),
      describe_('updated'),
      describe_('comment'),
      describe_('comment-edited'),
    ]).toEqual([
      'assigned',
      'unassigned',
      'moved to In Progress',
      'title edited',
      'labels changed',
      'updated',
      'comment',
      'comment edited',
    ])
  })
})
