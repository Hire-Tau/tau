/**
 * A tracked-link failure that maps directly onto an API status.
 *
 * It lives in its own leaf module so a provider adapter can answer with one — "this connection
 * needs revalidation" is not the same answer as "no such issue" — without importing the
 * work-stream service that consumes it.
 */
export class TrackedResourceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409
  ) {
    super(message)
    this.name = 'TrackedResourceError'
  }
}
