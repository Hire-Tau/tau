import type { IntegrationPluginV1 } from '../plugin'

export interface ProjectionConnection {
  id: string
  providerKey: string
  adapterVersion: number
  configuration: unknown
  credentialRef: string
  materialRevision: string
}

export interface IntegrationProjectionInput {
  plugin: IntegrationPluginV1<any, any, any>
  connection: ProjectionConnection
}

export interface PublicIntegrationDeclaration {
  packages: readonly string[]
  setupSteps: readonly { id: string; script: string }[]
  initHooks: readonly string[]
  readiness: readonly { id: string; command: string; expectedSubstring: string }[]
  skills: readonly string[]
  extensions: readonly string[]
  protectedBindingNames: readonly string[]
}

export interface IntegrationProjection {
  publicDeclaration: PublicIntegrationDeclaration
  privateMaterial: {
    bindings: ReadonlyMap<string, () => Promise<string>>
  }
  fingerprint: string
}
