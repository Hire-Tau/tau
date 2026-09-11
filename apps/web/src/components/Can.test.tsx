import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../queryKeys'
import { Can } from './Can'

function renderCan(permissions: string[] | undefined, permission = 'roles:read'): string {
  const queryClient = new QueryClient()
  if (permissions) {
    queryClient.setQueryData(queryKeys.auth.permissions(undefined), { permissions })
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Can permission={permission} fallback={<span>Fallback</span>}>
        <span>Allowed</span>
      </Can>
    </QueryClientProvider>
  )
}

describe('Can', () => {
  test('renders children when permission is allowed', () => {
    expect(renderCan(['roles:*'])).toContain('Allowed')
  })

  test('renders fallback when permission is denied or loading', () => {
    expect(renderCan(['users:read'])).toContain('Fallback')
    expect(renderCan(undefined)).toContain('Fallback')
  })
})
