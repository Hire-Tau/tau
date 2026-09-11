import {
  type SystemLogComponent,
  type SystemLogProvider,
  type SystemLogProviderDescriptor,
  type SystemLogStreamOptions,
  type SystemLogStreamResult,
  SystemLogProviderError,
} from './types'

export class UnavailableLogProvider implements SystemLogProvider {
  readonly name = 'unavailable'

  constructor(private readonly error: SystemLogProviderError) {}

  describe(components: SystemLogComponent[]): SystemLogProviderDescriptor {
    return { provider: 'unavailable', targets: components.map((component) => ({ component, kind: 'process' })) }
  }

  stream(
    _components: SystemLogComponent[],
    _opts: SystemLogStreamOptions,
    _onData: (chunk: Buffer) => void,
    onError?: (err: Error) => void
  ): SystemLogStreamResult {
    queueMicrotask(() => onError?.(this.error))
    return { cancel: () => {} }
  }
}
