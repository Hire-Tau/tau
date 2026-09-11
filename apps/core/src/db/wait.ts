import { createLogger } from '../lib/infra/logger'

const log = createLogger('db')

/** Log the underlying connection error on the first attempt and every Nth after. */
const DETAIL_EVERY = 5

/**
 * Redact the password of any `postgres://user:pass@` DSN embedded in an error
 * message. Postgres errors can echo connection params (and our own
 * validation errors embed DATABASE_URL verbatim), so never log the raw text.
 */
export function redactDbCredentials(message: string): string {
  return message.replace(/(postgres(?:ql)?:\/\/[^:@/\s]*):[^@\s]*@/gi, '$1:[REDACTED]@')
}

/**
 * One-line description of a connection failure. `AggregateError` needs special
 * handling: a refused connect across multiple resolved addresses surfaces as
 * an AggregateError whose own message is EMPTY — `String(err)` alone would be
 * just "AggregateError", which is exactly the kind of silence this exists to
 * avoid.
 */
function describeError(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    return `${String(err.message || err.name)}: ${err.errors.map((e) => String(e)).join('; ')}`
  }
  return String(err)
}

type WaitLogger = {
  info: (message: string) => void
  error: (message: string) => void
}

/**
 * Retry `probe` (a trivial query) until the database answers, logging WHY it
 * is failing — bad credentials, TLS rejection, DNS, refused connection — not
 * just that we are waiting. The underlying error is logged (redacted) on the
 * first failure, every {@link DETAIL_EVERY}th attempt, and always on
 * exhaustion; the thrown error carries the original as `cause`.
 */
export async function waitForDb(
  probe: () => Promise<unknown>,
  {
    maxRetries = 15,
    baseDelay = 500,
    logger = log,
  }: { maxRetries?: number; baseDelay?: number; logger?: WaitLogger } = {}
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await probe()
      return
    } catch (err) {
      const reason = redactDbCredentials(describeError(err))
      if (i === maxRetries - 1) {
        logger.error(`Database not reachable after ${maxRetries} attempts: ${reason}`)
        throw new Error(`Database not reachable after retries: ${reason}`, { cause: err })
      }
      const detail = i === 0 || (i + 1) % DETAIL_EVERY === 0 ? ` — ${reason}` : ''
      logger.info(`Waiting for database... (attempt ${i + 1}/${maxRetries})${detail}`)
      await new Promise((r) => setTimeout(r, Math.min(baseDelay * 2 ** i, 5000)))
    }
  }
}
