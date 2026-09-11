export interface SecondaryFailure {
  phase: string
  error: unknown
}

const SAFE_PHASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function primaryFirstError(
  primary: unknown,
  message: string,
  secondaryFailures: readonly SecondaryFailure[]
): AggregateError {
  const sanitized = secondaryFailures.map(({ phase }) => {
    const safePhase = SAFE_PHASE.test(phase) ? phase : 'secondary-operation'
    return new Error(`Secondary failure: ${safePhase}`)
  })
  return new AggregateError([primary, ...sanitized], message, { cause: primary })
}
