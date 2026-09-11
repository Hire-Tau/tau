import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { PermissionsProvider, usePermissions, type PermissionsResult } from '../hooks/usePermissions'
import { queries } from '../queryOptions'
import { ReactQueryHooksProvider, useQuery } from '../reactQueryHooks'

function QueryProbe() {
  const { data } = useQuery({ queryKey: ['probe'], queryFn: async () => 'network' })
  return <span>{String(data)}</span>
}

function PermissionsProbe({ permission = 'agents:read' }: { permission?: string }) {
  const result = usePermissions()
  return <span>{`${result.can(permission)}:${result.isLoading}:${result.isError}`}</span>
}

function permissions(can: boolean): PermissionsResult {
  return { permissions: can ? ['*'] : [], can: () => can, isLoading: false, isError: false }
}

describe('ReactQueryHooksProvider', () => {
  test('defaults to the real React Query hooks', () => {
    const client = new QueryClient()
    client.setQueryData(['probe'], 'cached')

    expect(
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <QueryProbe />
        </QueryClientProvider>
      )
    ).toContain('cached')
  })

  test('nested providers isolate overrides', () => {
    const hook = (value: string) => (() => ({ data: value })) as unknown as typeof useQuery
    const html = renderToStaticMarkup(
      <ReactQueryHooksProvider hooks={{ useQuery: hook('outer') }}>
        <QueryProbe />
        <ReactQueryHooksProvider hooks={{ useQuery: hook('inner') }}>
          <QueryProbe />
        </ReactQueryHooksProvider>
        <QueryProbe />
      </ReactQueryHooksProvider>
    )

    expect(html).toBe('<span>outer</span><span>inner</span><span>outer</span>')
  })

  test('concurrent renders do not share overrides', async () => {
    const render = async (value: string) => {
      await Promise.resolve()
      const hook = (() => ({ data: value })) as unknown as typeof useQuery
      return renderToStaticMarkup(
        <ReactQueryHooksProvider hooks={{ useQuery: hook }}>
          <QueryProbe />
        </ReactQueryHooksProvider>
      )
    }

    expect(await Promise.all([render('alpha'), render('beta')])).toEqual(['<span>alpha</span>', '<span>beta</span>'])
  })
})

describe('PermissionsProvider', () => {
  test('defaults to real fail-closed permission behavior', () => {
    const client = new QueryClient()
    client.setQueryData(queries.auth.permissions().queryKey, { permissions: [] })

    expect(
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <PermissionsProbe />
        </QueryClientProvider>
      )
    ).toContain('false:false:false')
  })

  test('nested providers isolate permission decisions', () => {
    const html = renderToStaticMarkup(
      <PermissionsProvider usePermissions={() => permissions(false)}>
        <PermissionsProbe />
        <PermissionsProvider usePermissions={() => permissions(true)}>
          <PermissionsProbe />
        </PermissionsProvider>
        <PermissionsProbe />
      </PermissionsProvider>
    )

    expect(html).toBe('<span>false:false:false</span><span>true:false:false</span><span>false:false:false</span>')
  })

  test('concurrent renders do not share permission decisions', async () => {
    const render = async (allowed: boolean) => {
      await Promise.resolve()
      return renderToStaticMarkup(
        <PermissionsProvider usePermissions={() => permissions(allowed)}>
          <PermissionsProbe />
        </PermissionsProvider>
      )
    }

    expect(await Promise.all([render(true), render(false)])).toEqual([
      '<span>true:false:false</span>',
      '<span>false:false:false</span>',
    ])
  })
})
