import { createLinePrefixer } from './stream-utils'
import {
  clampTailLines,
  type SystemLogComponent,
  type SystemLogProvider,
  type SystemLogProviderId,
  type SystemLogStreamOptions,
  type SystemLogStreamResult,
  SystemLogProviderError,
} from './types'

export { createLinePrefixer }

export interface CommandTarget {
  component: SystemLogComponent
  kind: 'process' | 'unit' | 'container' | 'file'
  argv: string[]
}

export interface SpawnedCommand {
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
  exited: Promise<number>
  kill: () => void
}

export type SpawnCommand = (argv: string[]) => SpawnedCommand

export const spawnCommand: SpawnCommand = (argv) => Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })

async function readStream(stream: ReadableStream<Uint8Array> | null, onChunk: (chunk: Buffer) => void): Promise<void> {
  if (!stream) return
  for await (const chunk of stream) onChunk(Buffer.from(chunk))
}

async function readStderr(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ''
  let output = ''
  for await (const chunk of stream) {
    if (output.length < 4096) {
      output += Buffer.from(chunk)
        .toString('utf8')
        .slice(0, 4096 - output.length)
    }
  }
  return output
}

/** Shared lifecycle for fixed-argv system log commands. */
export class CommandLogProvider implements SystemLogProvider {
  constructor(
    readonly name: Exclude<SystemLogProviderId, 'k8s' | 'unavailable'>,
    private readonly targetFor: (component: SystemLogComponent, opts: SystemLogStreamOptions) => CommandTarget,
    private readonly spawn: SpawnCommand = spawnCommand,
    private readonly reportDiagnostic: (message: string, cause?: unknown) => void = () => {},
    private readonly publicFailureMessage = 'Unable to read configured system logs.'
  ) {}

  describe(components: SystemLogComponent[]) {
    return {
      provider: this.name,
      targets: components.map((component) => ({
        component,
        kind: this.targetFor(component, { tailLines: 1, follow: false }).kind,
      })),
    }
  }

  stream(
    components: SystemLogComponent[],
    opts: SystemLogStreamOptions,
    onData: (chunk: Buffer) => void,
    onError?: (err: Error) => void,
    onEnd?: () => void
  ): SystemLogStreamResult {
    const processes: SpawnedCommand[] = []
    let canceled = false
    let failed = false
    let ended = false
    const cancel = () => {
      if (canceled) return
      canceled = true
      for (const proc of processes) {
        try {
          proc.kill()
        } catch {
          // Process has already exited.
        }
      }
    }
    const fatal = (cause: unknown) => {
      if (canceled || failed) return
      failed = true
      cancel()
      this.reportDiagnostic(`System log ${this.name} command failed.`, cause)
      onError?.(new SystemLogProviderError('STREAM_FAILED', this.publicFailureMessage))
    }

    // Yield so callers always receive a cancellation handle before any callback.
    queueMicrotask(() => {
      void Promise.all(
        components.map(async (component) => {
          if (canceled || failed) return
          let proc: SpawnedCommand
          try {
            const target = this.targetFor(component, { ...opts, tailLines: clampTailLines(opts.tailLines) })
            proc = this.spawn(target.argv)
            processes.push(proc)
          } catch (error) {
            fatal(error)
            return
          }

          const prefix = components.length > 1 ? createLinePrefixer(`[${component}] `) : undefined
          try {
            const [stderr, _stdoutComplete, exitCode] = await Promise.all([
              readStderr(proc.stderr),
              readStream(proc.stdout, (chunk) => {
                if (!canceled && !failed) onData(prefix ? prefix(chunk) : chunk)
              }),
              proc.exited,
            ])
            if (!canceled && exitCode !== 0) fatal(stderr || `Command exited with ${exitCode}`)
          } catch (error) {
            fatal(error)
          }
        })
      ).then(() => {
        if (!canceled && !failed && !opts.follow && !ended) {
          ended = true
          onEnd?.()
        }
      })
    })

    return { cancel }
  }
}
