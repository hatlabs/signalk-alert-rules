import { LevelRefusedError, RuleRejectedError, SessionExpiredError, type FieldError } from './api'

/** An expired login is recovered by logging in again; the operator's input is kept for a retry. */
export const SESSION_EXPIRED = 'Your login has expired. Log in again, then try again.'

/**
 * A write refused to a login that is still valid, as when an administrator
 * lowered the caller's level meanwhile: logging in again as the same user
 * would not help.
 */
export const NEEDS_ADMINISTRATOR =
  'Your login does not have the rights for this; it needs an administrator.'

/**
 * A write refused to a login that reads as read-only: it may have expired, on
 * a server that lets anyone read, or lack the rights.
 */
export const LOGIN_OR_ADMINISTRATOR =
  'Log in again, or ask an administrator: this action needs more rights than your login has.'

/** A field the server refused, named by its path in the rule. */
export function fieldErrorText(e: FieldError): string {
  return e.path === '' ? e.message : `${e.path.slice(1)} ${e.message}`
}

/**
 * What to tell the operator about a refused action: the server's own message,
 * with the fields it named.
 */
export function failureMessage(err: unknown): string {
  if (err instanceof SessionExpiredError) return SESSION_EXPIRED
  if (err instanceof LevelRefusedError) {
    return err.permissions === 'readonly' ? LOGIN_OR_ADMINISTRATOR : NEEDS_ADMINISTRATOR
  }
  if (err instanceof RuleRejectedError && err.errors.length > 0) {
    return `${err.message}: ${err.errors.map(fieldErrorText).join('; ')}`
  }
  return err instanceof Error ? err.message : String(err)
}
