import {
  cleanupFileCapturedChild,
  spawnFileCapturedChild,
  waitForCapturedJsonLine,
  type FileCapturedChild,
} from './node-conformance-process'
import { terminateProcess } from './subprocess-lifecycle'

interface ListeningRecord {
  port: number
  instanceId?: string
}

interface StartCandidateOptions {
  timeoutMs: number
  match: (value: unknown) => boolean
  signal?: AbortSignal
  ready?: (child: FileCapturedChild, record: ListeningRecord) => Promise<void>
}

export interface PublishedNodeCandidate {
  generation: number
  port: number
  instanceId?: string
  child: FileCapturedChild
}

export class NodeServiceOwner {
  private generation = 0
  private active?: { child: FileCapturedChild; record: ListeningRecord; generation: number }
  private starting?: Promise<PublishedNodeCandidate>
  private candidateController?: AbortController

  constructor(private readonly captureDir: string) {}

  startCandidate(command: string[], options: StartCandidateOptions): Promise<PublishedNodeCandidate> {
    if (this.active) {
      return Promise.resolve({
        generation: this.active.generation,
        port: this.active.record.port,
        instanceId: this.active.record.instanceId,
        child: this.active.child,
      })
    }
    if (this.starting) return this.starting
    this.candidateController = new AbortController()
    const onAbort = () => this.candidateController?.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    this.starting = this.start(command, { ...options, signal: this.candidateController.signal }).finally(() => {
      options.signal?.removeEventListener('abort', onAbort)
      this.starting = undefined
      this.candidateController = undefined
    })
    return this.starting
  }

  private async start(command: string[], options: StartCandidateOptions): Promise<PublishedNodeCandidate> {
    const child = spawnFileCapturedChild(command, this.captureDir)
    try {
      const record = await waitForCapturedJsonLine<ListeningRecord>(child, {
        phase: 'node-listening-record',
        timeoutMs: options.timeoutMs,
        match: options.match,
        signal: options.signal,
      })
      await options.ready?.(child, record)
      this.generation++
      this.active = { child, record, generation: this.generation }
      return { generation: this.generation, port: record.port, instanceId: record.instanceId, child }
    } catch (error) {
      try {
        await terminateProcess(child.proc)
      } finally {
        await cleanupFileCapturedChild(child)
      }
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.starting) {
      this.candidateController?.abort('service owner stopped')
      await this.starting.catch(() => {})
    }
    const active = this.active
    if (!active) return
    this.active = undefined
    try {
      await terminateProcess(active.child.proc)
    } finally {
      await cleanupFileCapturedChild(active.child)
    }
  }

  snapshot(): { generation: number; active: boolean } {
    return { generation: this.generation, active: this.active !== undefined }
  }
}
