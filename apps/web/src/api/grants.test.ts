import { describe, it, expect, mock } from 'bun:test'
import { createGrant, deleteGrant, listOutboundGrants, listInboundGrants } from './grants'

const apiFetchMock = mock(async () => undefined as unknown)

function mockApiFetch(response: unknown) {
  apiFetchMock.mockClear()
  apiFetchMock.mockResolvedValueOnce(response)
  return apiFetchMock
}

describe('grants API client', () => {
  it('lists outbound grants for a source squad', async () => {
    const fetchMock = mockApiFetch([
      {
        id: 'g1',
        sourceSquadId: 's1',
        granteeSquadId: 's2',
        policy: {},
        expiresAt: null,
        createdAt: '',
        updatedAt: '',
      },
    ])
    const grants = await listOutboundGrants('s1', fetchMock)
    expect(grants).toHaveLength(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/squads/s1/grants')
  })

  it('lists inbound grants for a grantee squad', async () => {
    const fetchMock = mockApiFetch([])
    await listInboundGrants('s2', fetchMock)
    expect(fetchMock.mock.calls[0][0]).toBe('/squads/s2/granted')
  })

  it('creates a grant via POST', async () => {
    const fetchMock = mockApiFetch({
      id: 'new',
      sourceSquadId: 's1',
      granteeSquadId: 's2',
      policy: { read: { sourceTypes: ['memory_file'] } },
      expiresAt: null,
      createdAt: '',
      updatedAt: '',
    })
    const grant = await createGrant(
      's1',
      { granteeSquadId: 's2', policy: { read: { sourceTypes: ['memory_file'] } } },
      fetchMock
    )
    expect(grant.id).toBe('new')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST')
  })

  it('deletes a grant via DELETE', async () => {
    const fetchMock = mockApiFetch(undefined)
    await deleteGrant('g1', fetchMock)
    expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE')
    expect(fetchMock.mock.calls[0][0]).toBe('/grants/g1')
  })
})
