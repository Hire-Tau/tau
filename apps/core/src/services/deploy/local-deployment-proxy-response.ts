export const LOCAL_DEPLOYMENT_PROXY_ERROR_HEADER = 'x-tau-app-proxy'
// The control plane treats either spelling as Core's marker while the Ficus
// rename is in flight, so an app response must be cleared of both.
const PROXY_ERROR_MARKER_SPELLINGS = [LOCAL_DEPLOYMENT_PROXY_ERROR_HEADER, 'x-ficus-app-proxy']

export function localDeploymentProxyError(body: BodyInit, status: number, headers?: HeadersInit): Response {
  const markedHeaders = new Headers(headers)
  markedHeaders.set(LOCAL_DEPLOYMENT_PROXY_ERROR_HEADER, 'error')
  return new Response(body, { status, headers: markedHeaders })
}

export function localDeploymentProxyJsonError(error: string, status: number): Response {
  return localDeploymentProxyError(JSON.stringify({ error }), status, { 'content-type': 'application/json' })
}

/** Never let an app forge the internal Core-to-Platform error marker. */
export function stripLocalDeploymentProxyErrorMarker(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const name of PROXY_ERROR_MARKER_SPELLINGS) headers.delete(name)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
