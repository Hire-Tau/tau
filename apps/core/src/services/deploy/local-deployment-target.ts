import { getSandboxManager } from '../sandbox'

interface LocalDeploymentTargetDependencies {
  getSandboxManager: typeof getSandboxManager
}

let dependencyOverrides: Partial<LocalDeploymentTargetDependencies> = {}

export function configureLocalDeploymentTargetDependencies(overrides: Partial<LocalDeploymentTargetDependencies> = {}) {
  dependencyOverrides = overrides
}

function getDependencies(): LocalDeploymentTargetDependencies {
  return {
    getSandboxManager: dependencyOverrides.getSandboxManager ?? getSandboxManager,
  }
}

export async function resolveLocalDeploymentTarget(
  sandboxId: string,
  port: number
): Promise<{ host: string; port: number }> {
  const { getSandboxManager } = getDependencies()
  const manager = getSandboxManager()
  if (!manager.getLocalDeploymentTarget)
    throw new Error('LocalDeployment targets are not supported by this sandbox runtime')
  return manager.getLocalDeploymentTarget(sandboxId, port)
}
