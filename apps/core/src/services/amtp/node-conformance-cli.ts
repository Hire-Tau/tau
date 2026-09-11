import type { ScenarioOperation, ScenarioScope } from './node-conformance-scenario'

interface ScopedCliProcessOptions<T> {
  scope?: ScenarioScope
  operation?: ScenarioOperation
  signal?: AbortSignal
  run(signal?: AbortSignal): Promise<T>
}

/** Propagates scenario cancellation and keeps the operation owned until the child settles. */
export function runScopedCliProcess<T>({ scope, operation, signal, run }: ScopedCliProcessOptions<T>): Promise<T> {
  const scopeSignal = scope?.signal
  const effectiveSignal = signal && scopeSignal ? AbortSignal.any([signal, scopeSignal]) : (signal ?? scopeSignal)
  const process = run(effectiveSignal)
  return scope && operation ? scope.track(operation, process) : process
}
