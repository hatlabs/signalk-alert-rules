/** A rule's condition name and alert path in validation. */
import {
  MAX_ALERT_PATH_LENGTH,
  WILDCARD,
  alertParent,
  alertPathOf,
  segmentAccepted,
  singlePath
} from '../alerts/paths.js'
import { isRecord } from '../util.js'
import type { Rule } from './rule.js'
import type { ValidationError } from './validate.js'

/** Where a rule document's condition name is. */
export const CONDITION_POINTER = '/condition'

/**
 * The error of a rule document that stores no condition name and has no
 * default one, or undefined. Reads the unvalidated document, so the error is
 * reported with the schema's.
 */
export function conditionMissing(raw: unknown): ValidationError | undefined {
  if (!isRecord(raw) || raw.condition !== undefined) return undefined
  if (isRecord(raw.signal) && 'combinator' in raw.signal)
    return {
      path: CONDITION_POINTER,
      message: 'is required: a rule over several paths has no default name'
    }
  if (singlePath(raw.signal)?.split('.').at(-1) === WILDCARD)
    return {
      path: CONDITION_POINTER,
      message: 'is required: an input path ending in a wildcard has no default name'
    }
  return undefined
}

// Where the input that gives the alert path's parent is; a combined signal's
// parent is common to its inputs, so the first stands for them.
function inputAt(rule: Rule): string {
  return 'combinator' in rule.signal ? '/signal/inputs/0/path' : '/signal/path'
}

/** The problems of a rule's alert path that its schema cannot see. */
export function alertPathErrors(rule: Rule): ValidationError[] {
  const { condition } = rule
  // The schema has checked the characters; this leaves the names core forbids.
  if (condition !== undefined && !segmentAccepted(condition))
    return [{ path: CONDITION_POINTER, message: `"${condition}" is not allowed in an alert path` }]
  const forbidden = alertParent(rule.signal)?.find((s) => s !== WILDCARD && !segmentAccepted(s))
  if (forbidden !== undefined)
    return [{ path: inputAt(rule), message: `"${forbidden}" is not allowed in an alert path` }]
  const path = alertPathOf(rule)
  if (path !== undefined && path.length > MAX_ALERT_PATH_LENGTH) {
    const message = `makes the alert path longer than ${String(MAX_ALERT_PATH_LENGTH)} characters`
    return [{ path: condition === undefined ? inputAt(rule) : CONDITION_POINTER, message }]
  }
  return []
}

/**
 * A validated rule's alert path, without the `alerts.` prefix. A wildcard
 * rule's has a `*` where each instance's segment goes.
 */
export function ruleAlertPath(rule: Rule): string {
  const path = alertPathOf(rule)
  // Validation refuses a rule without a condition name to use.
  if (path === undefined) throw new Error(`rule ${rule.slug} has no alert path`)
  return path
}
