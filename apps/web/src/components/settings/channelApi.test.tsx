import { describe, expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import { ChannelApiProvider, useChannelApi } from './channelApi'

function Probe({ select }: { select: (api: ReturnType<typeof useChannelApi>) => string }) {
  return <>{select(useChannelApi())}</>
}

describe('ChannelApiProvider', () => {
  test('scopes overrides to one tree and merges them with real defaults', () => {
    const create = async () => ({ id: 'foreign' }) as never
    const overridden = renderToString(
      <ChannelApiProvider api={{ createChannelInstance: create }}>
        <Probe select={(api) => `${api.createChannelInstance === create}:${typeof api.updateChannelInstance}`} />
      </ChannelApiProvider>
    )
    const defaultTree = renderToString(
      <Probe select={(api) => `${api.createChannelInstance === create}:${typeof api.updateChannelInstance}`} />
    )

    expect(overridden).toBe('true:function')
    expect(defaultTree).toBe('false:function')
  })

  test('does not let an explicit undefined override erase a required real default', () => {
    const output = renderToString(
      <ChannelApiProvider api={{ updateChannelInstance: undefined }}>
        <Probe select={(api) => typeof api.updateChannelInstance} />
      </ChannelApiProvider>
    )
    expect(output).toBe('function')
  })

  test('keeps concurrent sibling overrides independent', () => {
    const first = async () => ({ id: 'first' }) as never
    const second = async () => ({ id: 'second' }) as never
    const output = renderToString(
      <>
        <ChannelApiProvider api={{ createChannelInstance: first }}>
          <Probe select={(api) => String(api.createChannelInstance === first)} />
        </ChannelApiProvider>
        <ChannelApiProvider api={{ createChannelInstance: second }}>
          <Probe select={(api) => String(api.createChannelInstance === second)} />
        </ChannelApiProvider>
      </>
    )
    expect(output).toBe('true<!-- -->true')
  })
})
