export const SPEC_HASH_LABEL = 'tau.spec-hash'

export function classifyDockerInspectStatus(exitCode: number, stderr: string): 'running' | 'not_found' | 'unknown' {
  if (exitCode === 0) return 'running'
  if (/no such (object|container)/i.test(stderr)) return 'not_found'
  return 'unknown'
}

export function classifyDockerContainerOwnership(
  inspected: any,
  sandboxId: string,
  expectedName: string,
  expectedWorkspacePath?: string
): 'current' | 'legacy' | 'unproven' {
  const labels = inspected?.Config?.Labels ?? {}
  if (
    labels['tau.managed'] === 'true' &&
    labels['tau.sandbox-id'] === sandboxId &&
    inspected?.Name === `/${expectedName}`
  )
    return 'current'
  const legacyMount =
    expectedWorkspacePath && inspected?.Mounts?.some((mount: any) => mount?.Source === expectedWorkspacePath)
  if (inspected?.Name === `/${expectedName}` && Boolean(labels[SPEC_HASH_LABEL]) && legacyMount) return 'legacy'
  return 'unproven'
}
