// Public API — runtime-agnostic. Import docker/ or k8s/ directly for specifics.
export * from './types'
export {
  getSandboxManager,
  createCodingTools,
  isK8sRuntime,
  isVmRuntime,
  isHostRuntime,
  isRemoteSandboxRuntime,
  validateSandboxSetup,
} from './factory'
export { prewarmSandboxBackground } from './prewarm'
export { ensureWorkspaceSandbox, ensureSquadSandbox, getAgentWorkspaceStoragePath } from './ensure'
export { ensureAgentSandbox } from './agent-warmup'
export { warmupWorkStreamAgentSandboxes } from './work-stream-warmup'
export { hasRecentWorkStreamActivityForSandbox } from './work-stream-activity'
export {
  archiveAgentPrivateDir,
  purgeExpiredAgentPrivateArchives,
  startAgentPrivateArchiveJanitor,
  stopAgentPrivateArchiveJanitor,
} from './private-archive'
