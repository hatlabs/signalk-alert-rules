import { RuleRejectedError, SessionExpiredError } from './api'

/**
 * What to tell the operator about a refused action: the server's own message,
 * with the fields it named. An expired session says how to recover, since the
 * operator's input is kept for a retry after logging in again.
 */
export function failureMessage(err: unknown): string {
  if (err instanceof SessionExpiredError) {
    return 'Your session has expired or lacks administrator rights; log in as an administrator, then try again.'
  }
  if (err instanceof RuleRejectedError && err.errors.length > 0) {
    const fields = err.errors.map((e) =>
      e.path === '' ? e.message : `${e.path.slice(1)} ${e.message}`
    )
    return `${err.message}: ${fields.join('; ')}`
  }
  return err instanceof Error ? err.message : String(err)
}
