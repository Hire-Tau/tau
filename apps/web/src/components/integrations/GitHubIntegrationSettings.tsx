import { CheckIcon, ClipboardIcon } from '../icons'
import { GitHubWebhookSettings } from './GitHubWebhookSettings'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { IntegrationAuthorizationStart } from '@tau/shared'
import { TAU_GITHUB_APP_CLIENT_ID } from '@tau/shared/github-app'
import {
  setIntegrationDefault,
  setIntegrationEnabled,
  cancelIntegrationDeviceAuthorization,
  configureIntegrationOAuthApp,
  integrationAction,
  pollIntegrationDeviceAuthorization,
  removeIntegration,
  startIntegrationAuthorization,
} from '../../api/integrations'
import { integrationQueries } from '../../queryOptions'
import { integrationAuthorizationReturnPath } from '../../lib/integrationReturnPath'
import { integrationQueryKeys, onboardingQueryKeys } from '../../queryKeys'

type DeviceLogin = Extract<IntegrationAuthorizationStart, { kind: 'device' }>

export function GitHubIntegrationSettings({
  canRead,
  canWrite,
  embedded = false,
  onboarding = false,
}: {
  canRead: boolean
  canWrite: boolean
  embedded?: boolean
  onboarding?: boolean
}) {
  const client = useQueryClient()
  const pool = useQuery({ ...integrationQueries.pool('github'), enabled: canRead })
  const catalog = useQuery({ ...integrationQueries.catalog(), enabled: canRead && onboarding })
  const githubEnabled = catalog.data?.integrations?.find((integration) => integration.key === 'github')?.enabled
  const app = useQuery({ ...integrationQueries.oauthApp('github'), enabled: canRead })
  // A connection may finish in another tab, or after the checklist's first request.
  // Re-read the checklist after fresh account/provider data, not only local mutations.
  useEffect(() => {
    if (onboarding && canRead && pool.isSuccess) void client.invalidateQueries({ queryKey: onboardingQueryKeys.all })
  }, [client, onboarding, canRead, pool.isSuccess, pool.data, pool.dataUpdatedAt, catalog.data, catalog.dataUpdatedAt])
  const [device, setDevice] = useState<DeviceLogin | null>(null)
  const deviceMinutesRemaining = device
    ? Math.max(0, Math.ceil((new Date(device.expiresAt).getTime() - Date.now()) / 60_000))
    : 0
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: integrationQueryKeys.all }),
      client.invalidateQueries({ queryKey: onboardingQueryKeys.all }),
    ])
  const defaultMutation = useMutation({
    mutationFn: (id: string) => setIntegrationDefault('github', id),
    onSuccess: refresh,
  })
  const useConnected = useMutation({
    mutationFn: () => setIntegrationEnabled('github', true),
    onSuccess: refresh,
  })
  const authorize = useMutation({
    mutationFn: async (connectionId?: string) => {
      if (onboarding) await setIntegrationEnabled('github', true)
      return startIntegrationAuthorization('github', {
        returnTo: onboarding
          ? (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '') + '/onboarding'
          : integrationAuthorizationReturnPath(),
        ...(connectionId ? { connectionId } : {}),
      })
    },
    onMutate: () => {
      setError('')
      setNotice('')
    },
    onSuccess: (result) => {
      if ('authorizationUrl' in result) window.location.assign(result.authorizationUrl)
      else setDevice(result)
    },
  })
  useEffect(() => {
    if (!device || !canWrite) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await pollIntegrationDeviceAuthorization(device.id)
        if (stopped) return
        setError('')
        if (result.status === 'complete') {
          setDevice(null)
          setNotice('GitHub account connected. Squads inherit the global default unless they choose another account.')
          await Promise.all([
            client.invalidateQueries({ queryKey: integrationQueryKeys.all }),
            client.invalidateQueries({ queryKey: onboardingQueryKeys.all }),
          ])
        } else if (result.status === 'failed') {
          setDevice(null)
          setError('GitHub authorization expired or was declined. Connect again to start a new login.')
        } else timer = setTimeout(poll, Math.max(1, result.retryAfterSeconds) * 1000)
      } catch {
        if (stopped) return
        setError('Unable to check GitHub authorization. Retrying…')
        timer = setTimeout(poll, Math.max(5, device.intervalSeconds) * 1000)
      }
    }
    timer = setTimeout(poll, device.intervalSeconds * 1000)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [device, canWrite, client])
  useEffect(() => {
    if (!canWrite) {
      setClientSecret('')
      setAcknowledged(false)
      setDevice(null)
    }
  }, [canWrite])
  const cancel = useMutation({
    mutationFn: () => cancelIntegrationDeviceAuthorization(device!.id),
    onSuccess: () => {
      setDevice(null)
      setError('')
    },
  })
  const configure = useMutation({
    mutationFn: (useDefault: boolean) =>
      configureIntegrationOAuthApp(
        'github',
        useDefault
          ? { useDefault: true }
          : {
              clientId,
              ...(clientSecret ? { clientSecret } : {}),
              capabilitiesAcknowledged: true,
            }
      ),
    onSuccess: async () => {
      setAcknowledged(false)
      await refresh()
    },
    onSettled: () => setClientSecret(''),
  })
  const lifecycle = useMutation({
    mutationFn: async (input: { id: string; action: 'enable' | 'disable' | 'remove'; assigned: boolean }) => {
      if (input.action === 'remove') await removeIntegration(input.id, input.assigned)
      else await integrationAction(input.id, input.action, input.assigned)
    },
    onSuccess: async (_result, input) => {
      setConfirmation(null)
      if (input.action === 'remove')
        setNotice(
          'Account disconnected from Tau. To revoke its GitHub authorization too, open GitHub settings → Applications → Authorized GitHub Apps.'
        )
      await refresh()
    },
  })
  const sortedAccounts = [...(pool.data ?? [])].sort(
    (left, right) => Number(right.isGlobalDefault) - Number(left.isGlobalDefault)
  )
  const hasAccounts = (pool.data?.length ?? 0) > 0
  const canConnect = canWrite && app.data?.configured && pool.isSuccess
  const usesTauApp = app.data?.authority === 'platform_broker' || app.data?.clientId === TAU_GITHUB_APP_CLIENT_ID
  if (!canRead) return null
  return (
    <section className={embedded ? undefined : 'border-b border-panel-border py-5'}>
      <div className="flex items-center justify-between gap-3">
        {!embedded && <h3 className="text-sm font-medium text-primary">GitHub</h3>}
        {canConnect && !hasAccounts && (
          <button
            type="button"
            className="tau-button tau-button-primary px-3 py-2 text-sm"
            disabled={authorize.isPending || !!device}
            onClick={() => authorize.mutate(undefined)}
          >
            Connect account
          </button>
        )}
      </div>
      <p className="mt-2 text-sm text-muted">
        {onboarding
          ? 'Connect your GitHub account, then grant repository access.'
          : 'The first connected account becomes the global default. Squads inherit it automatically and can choose other accounts.'}
      </p>
      <p className="mt-2 text-xs text-muted">
        Connecting an account does not grant repository access. Install{' '}
        {usesTauApp ? 'Tau Integration' : 'your GitHub App'} on your personal account or organization and choose its
        repositories. Organization access may require an owner's approval.
      </p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs text-accent-light">
        {usesTauApp && (
          <a href="https://github.com/apps/tau-integration/installations/new" target="_blank" rel="noreferrer">
            Grant repository access
          </a>
        )}
        <a href="https://github.com/settings/installations" target="_blank" rel="noreferrer">
          Manage GitHub App installations
        </a>
      </div>
      {(app.isPending || pool.isPending) && (
        <p role="status" className="mt-3 text-sm text-muted">
          Loading GitHub connections…
        </p>
      )}
      {device && (
        <div className="tau-inset my-3 space-y-2 p-3" role="status">
          <p className="text-sm">Enter this code on GitHub:</p>
          <GitHubDeviceCode key={device.id} code={device.userCode} />
          <div className="flex gap-3">
            <a
              className="tau-button tau-button-primary px-3 py-2 text-sm"
              href={device.verificationUri}
              target="_blank"
              rel="noreferrer"
            >
              Open GitHub
            </a>
            <button
              type="button"
              className="tau-button px-3 py-2 text-sm"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </button>
          </div>
          <p className="text-xs text-muted">
            {deviceMinutesRemaining > 0
              ? `Waiting for authorization. This code expires in ${deviceMinutesRemaining} ${deviceMinutesRemaining === 1 ? 'minute' : 'minutes'}.`
              : 'This code has expired. Start a new login to continue.'}
          </p>
        </div>
      )}
      {defaultMutation.isError && (
        <p role="alert" className="text-sm text-red-500">
          Could not change the global default. Please try again.
        </p>
      )}
      {sortedAccounts.map((connection) => (
        <div
          key={connection.id}
          className="flex flex-wrap items-center justify-between gap-3 border-b border-panel-border py-3"
        >
          <div>
            <p className="text-sm font-medium">
              {connection.displayName}
              {connection.isGlobalDefault && <span className="ml-2 text-xs text-accent-light">Global default</span>}
            </p>
            <p className="text-xs text-muted">
              @{connection.configuration.login} ·{' '}
              {connection.enabled
                ? connection.authState === 'authenticated'
                  ? connection.healthState
                  : 'Reconnect required'
                : 'Disabled'}{' '}
              · Used by {connection.usage.squadCount} squads
            </p>
          </div>
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              {!connection.isGlobalDefault && connection.enabled && (
                <button
                  type="button"
                  className="tau-button text-xs"
                  disabled={defaultMutation.isPending}
                  onClick={() => defaultMutation.mutate(connection.id)}
                >
                  Make global default
                </button>
              )}
              <button
                type="button"
                className="tau-button text-xs"
                disabled={authorize.isPending || !!device}
                onClick={() => authorize.mutate(connection.id)}
              >
                Reconnect
              </button>
              {(['toggle', 'remove'] as const).map((kind) => {
                const action = kind === 'toggle' ? (connection.enabled ? 'disable' : 'enable') : 'remove'
                const key = `${connection.id}:${action}`
                const assigned = action !== 'enable' && connection.usage.squadCount > 0
                return (
                  <button
                    key={kind}
                    type="button"
                    className="tau-button text-xs"
                    disabled={lifecycle.isPending}
                    onClick={() => {
                      if (assigned && confirmation !== key) {
                        setConfirmation(key)
                        return
                      }
                      lifecycle.mutate({ id: connection.id, action, assigned })
                    }}
                  >
                    {confirmation === key
                      ? `Confirm for ${connection.usage.squadCount} squads`
                      : action === 'remove'
                        ? 'Disconnect'
                        : action === 'enable'
                          ? 'Enable'
                          : 'Disable'}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {onboarding &&
          canWrite &&
          githubEnabled === false &&
          pool.data?.some(
            (connection) =>
              connection.enabled && connection.authState === 'authenticated' && connection.healthState === 'healthy'
          ) && (
            <button
              type="button"
              onClick={() => useConnected.mutate()}
              disabled={useConnected.isPending}
              className="tau-button tau-button-primary mt-3 rounded-lg px-3 py-2 text-sm"
            >
              Use GitHub
            </button>
          )}
        {canConnect && hasAccounts && (
          <button
            type="button"
            className="tau-button mt-3 text-sm text-accent-light hover:text-accent-hover disabled:opacity-50"
            disabled={authorize.isPending || !!device}
            onClick={() => authorize.mutate(undefined)}
          >
            Connect another account
          </button>
        )}
      </div>
      {!onboarding && app.data?.authority === 'local' && canWrite && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-muted">Use your own GitHub App</summary>
          <form
            className="mt-3 space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (acknowledged) configure.mutate(false)
            }}
          >
            <p className="text-xs text-muted">
              Enable device flow and expiring user tokens. A public client ID is enough for device login. For browser
              login, also provide the app's client secret and set its callback to{' '}
              <span className="break-all">{app.data.callbackUrl}</span>.
            </p>
            <label className="block text-sm text-primary">
              Client ID
              <input
                className="tau-field mt-1 block h-10 w-full px-3 py-2 text-sm"
                aria-label="GitHub App client ID"
                placeholder="Iv23li…"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                required
              />
            </label>
            <label className="block text-sm text-primary">
              Client secret <span className="text-muted">(optional)</span>
              <input
                className="tau-field mt-1 block h-10 w-full px-3 py-2 text-sm"
                aria-label="GitHub App client secret (optional)"
                placeholder="Enter a client secret for browser login"
                type="password"
                autoComplete="off"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </label>
            <label className="flex gap-2 text-xs text-muted">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />I
              enabled the required repository permissions: {app.data.requiredCapabilities.join(', ')}.
            </label>
            <div className="flex gap-3">
              <button
                className="tau-button text-sm"
                disabled={!clientId.trim() || !acknowledged || configure.isPending || !!device}
              >
                Save app
              </button>
              <button
                type="button"
                className="tau-button text-sm"
                disabled={configure.isPending || !!device}
                onClick={() => configure.mutate(true)}
              >
                Use Tau app
              </button>
            </div>
          </form>
        </details>
      )}
      {!onboarding && <GitHubWebhookSettings canWrite={canWrite} managed={app.data?.authority === 'platform_broker'} />}
      {notice && (
        <p role="status" className="mt-3 text-sm text-muted">
          {notice}
        </p>
      )}
      {(error ||
        app.isError ||
        pool.isError ||
        authorize.isError ||
        cancel.isError ||
        configure.isError ||
        lifecycle.isError ||
        useConnected.isError) && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error || 'GitHub operation failed. Please try again.'}
        </p>
      )}
    </section>
  )
}

function GitHubDeviceCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="select-all font-mono text-xl tracking-widest">{code}</p>
      <button
        type="button"
        aria-label="Copy GitHub device code"
        title={copied ? 'Copied' : 'Copy code'}
        className="tau-button rounded-md p-1.5 text-muted hover:text-primary"
        onClick={async () => {
          setCopyFailed(false)
          try {
            await navigator.clipboard.writeText(code)
            setCopied(true)
          } catch {
            setCopied(false)
            setCopyFailed(true)
          }
        }}
      >
        {copied ? <CheckIcon className="h-4 w-4" /> : <ClipboardIcon className="h-4 w-4" />}
      </button>
      {copied && <span className="text-xs text-muted">Copied</span>}
      {copyFailed && <span className="text-xs text-muted">Could not copy. Select the code to copy it manually.</span>}
    </div>
  )
}
