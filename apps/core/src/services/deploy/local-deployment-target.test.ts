import { afterEach, describe, expect, it } from 'bun:test'
import { configureLocalDeploymentTargetDependencies, resolveLocalDeploymentTarget } from './local-deployment-target'

describe('resolveLocalDeploymentTarget', () => {
  afterEach(() => {
    configureLocalDeploymentTargetDependencies()
  })

  it('throws when the sandbox runtime does not support localDeployment targets', async () => {
    configureLocalDeploymentTargetDependencies({
      getSandboxManager: () => ({}) as any,
    })

    await expect(resolveLocalDeploymentTarget('squad_1', 5173)).rejects.toThrow(
      'LocalDeployment targets are not supported by this sandbox runtime'
    )
  })

  it('delegates target resolution to the active sandbox manager', async () => {
    const manager = {
      getLocalDeploymentTarget: async (sandboxId: string, port: number) => ({ host: `${sandboxId}.internal`, port }),
    }
    configureLocalDeploymentTargetDependencies({
      getSandboxManager: () => manager as any,
    })

    await expect(resolveLocalDeploymentTarget('squad_1', 5173)).resolves.toEqual({
      host: 'squad_1.internal',
      port: 5173,
    })
  })
})
