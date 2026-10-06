/**
 * Paths that address one field of an object value: a Signal K path, `#`,
 * and an RFC 6901 pointer (`navigation.attitude#/roll`), the form Skip and
 * the history providers use. The webapp parses paths with this module too,
 * so it imports nothing.
 */

/** Skip's wording for a pointer that is not one, so both say the same. */
export const POINTER_MESSAGE =
  'After "#", write the field name starting with "/", for example "#/roll".'

/** A field name becomes a segment of the alert path, so it holds what a segment may. */
export const POINTER_TOKEN_MESSAGE = 'A field name after "#" cannot contain dots, whitespace or *.'

/** Zones are metadata of a path, never of a field of its value; the webapp shows this too. */
export const FIELD_ZONES_MESSAGE = 'A field has no zones: turn this off and type the limits.'

/**
 * A path split into the Signal K path it reads and the tokens of the
 * pointer into that path's value; no tokens for a plain path, which
 * addresses the whole value. An invalid result keeps the base path, so the
 * problem can be explained against the path meant.
 */
export type PointerPath =
  | { valid: true; basePath: string; tokens: readonly string[] }
  | { valid: false; basePath: string; message: string }

const POINTER_START = '#'
const TOKEN_SEPARATOR = '/'
// RFC 6901 has two escapes; any other "~" is malformed.
const STRAY_TILDE = /~(?![01])/
// Tokens become path segments, which these would split or turn into a wildcard.
const NOT_IN_TOKEN = /[.\s*]/

/** Whether the path addresses a field of its value rather than the value. */
export function isPointerPath(path: string): boolean {
  return path.includes(POINTER_START)
}

/**
 * Split a path at its `#` into the Signal K path and the pointer's tokens.
 * An empty pointer is refused though RFC 6901 allows it: the path without
 * `#` already addresses the whole value. A second `#` is refused, so a path
 * has one reading.
 */
export function splitPointerPath(path: string): PointerPath {
  const hash = path.indexOf(POINTER_START)
  if (hash === -1) return { valid: true, basePath: path, tokens: [] }
  const basePath = path.slice(0, hash)
  const pointer = path.slice(hash + 1)
  const invalid = (message: string): PointerPath => ({ valid: false, basePath, message })
  if (
    !pointer.startsWith(TOKEN_SEPARATOR) ||
    pointer.includes(POINTER_START) ||
    STRAY_TILDE.test(pointer)
  )
    return invalid(POINTER_MESSAGE)
  const tokens = pointer.slice(1).split(TOKEN_SEPARATOR).map(unescapeToken)
  if (tokens.some((t) => t === '')) return invalid(POINTER_MESSAGE)
  if (tokens.some((t) => NOT_IN_TOKEN.test(t))) return invalid(POINTER_TOKEN_MESSAGE)
  return { valid: true, basePath, tokens }
}

/**
 * The path's segments: the base path's, then the field's tokens.
 * Undefined when the pointer is invalid.
 */
export function pathSegments(path: string): string[] | undefined {
  const split = splitPointerPath(path)
  return split.valid ? [...split.basePath.split('.'), ...split.tokens] : undefined
}

/**
 * The field the tokens address in a value, undefined when the value has no
 * such field. Only an object's own fields count: the tokens come from a
 * rule, and `#/constructor` must not read what every object inherits.
 */
export function resolvePointer(value: unknown, tokens: readonly string[]): unknown {
  let field = value
  for (const token of tokens) {
    if (typeof field !== 'object' || field === null || Array.isArray(field)) return undefined
    if (!Object.hasOwn(field, token)) return undefined
    field = (field as Record<string, unknown>)[token]
  }
  return field
}

// RFC 6901 decodes ~1 before ~0, so that ~01 is "~1" and not "/".
function unescapeToken(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~')
}
