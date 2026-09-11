import type { Squad } from '../../entities/Squad'
import { fingerprintToolchain, isEmptyToolchain } from './toolchain/config'
import { getProvisionState, type ProvisionState } from './toolchain/state'

export type ToolchainStatusPayload = Pick<ProvisionState, 'status' | 'desiredFingerprint'> &
  Partial<Omit<ProvisionState, 'status' | 'desiredFingerprint'>>

export async function resolveToolchainStatus(
  sandboxId: string,
  squad: Squad | null | undefined
): Promise<ToolchainStatusPayload | undefined> {
  const config = squad?.toolchainConfig
  if (!config || isEmptyToolchain(config)) return undefined
  const desiredFingerprint = fingerprintToolchain(config)
  return (
    (await getProvisionState(sandboxId, desiredFingerprint)) ?? {
      status: 'pending',
      desiredFingerprint,
    }
  )
}

export function mergeSandboxStatus<T extends { devboxReady?: boolean }>(
  physical: T,
  toolchain?: ToolchainStatusPayload
): Omit<T, 'devboxReady'> & { toolchain?: ToolchainStatusPayload; devboxReady?: boolean } {
  if (!toolchain) return physical
  return {
    ...physical,
    toolchain,
    devboxReady: physical.devboxReady !== false && toolchain.status === 'ready',
  }
}
