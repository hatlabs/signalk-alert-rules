import type { TSchema } from 'typebox'
import Value from 'typebox/value'
import {
  DISCRIMINATOR_KEY,
  PATTERN_MESSAGE_KEY,
  RuleSchema,
  type CombinatorKind,
  type Event,
  type Limit,
  type Rule,
  type Signal,
  zoneLimitOf
} from './rule.js'
import { wildcards } from '../alerts/paths.js'
import { alertPathErrors, conditionMissing } from './alertPath.js'
import { isRecord, pointer } from '../util.js'

/** A validation failure; `path` is a JSON pointer into the validated document. */
export interface ValidationError {
  path: string
  message: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: ValidationError[] }

/** What the server knows about a path; either field is absent when unknown. */
export interface PathInfo {
  units?: string
  valueType?: 'number' | 'string' | 'boolean' | 'object'
}

/**
 * Checks that need the server's knowledge of a path run only when `pathInfo`
 * answers for it. A rule saved before its path reports passes them; the
 * evaluator repeats them when the path's meta or first value arrives and
 * reports a failing rule as inactive, with the same wording.
 */
export interface ValidationContext {
  pathInfo?: (path: string) => PathInfo | undefined
}

export function angularUnitsMessage(units: string): string {
  return `angular combination needs radians, the path is in ${units}`
}

export function timeoutValueTypeMessage(valueType: 'boolean' | 'string'): string {
  return `core never times out ${valueType} paths`
}

export const TWO_INPUTS: ReadonlySet<CombinatorKind> = new Set([
  'difference',
  'absDifference',
  'ratio',
  'distance'
])
export const POSITION_COMBINATORS: ReadonlySet<CombinatorKind> = new Set([
  'distance',
  'positionSpread'
])
export const ANGULAR_COMBINATORS: ReadonlySet<CombinatorKind> = new Set([
  'difference',
  'absDifference',
  'mean',
  'spread'
])

function fail<T>(errors: ValidationError[]): Result<T> {
  return { ok: false, errors }
}

export function prefixed(errors: ValidationError[], at: string): ValidationError[] {
  return errors.map((e) => ({ path: at + e.path, message: e.message }))
}

// The walk below reads the JSON Schema that typebox produces.
interface SchemaNode {
  type?: string
  const?: unknown
  enum?: unknown[]
  anyOf?: SchemaNode[]
  properties?: Record<string, SchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: SchemaNode
  minItems?: number
  maxItems?: number
  [DISCRIMINATOR_KEY]?: string
  [PATTERN_MESSAGE_KEY]?: string
}

function constsOf(schema: SchemaNode): unknown[] | undefined {
  if (schema.const !== undefined) return [schema.const]
  if (schema.enum) return schema.enum
  if (schema.anyOf?.every((v) => v.const !== undefined)) return schema.anyOf.map((v) => v.const)
  return undefined
}

function acceptsType(schema: SchemaNode, value: unknown): boolean {
  if (schema.anyOf) return schema.anyOf.some((v) => acceptsType(v, value))
  if (schema.const !== undefined) return typeof schema.const === typeof value
  if (schema.enum) return schema.enum.some((v) => typeof v === typeof value)
  switch (schema.type) {
    case 'number':
    case 'integer':
      return typeof value === 'number'
    case 'object':
      return isRecord(value)
    case 'array':
      return Array.isArray(value)
    default:
      return typeof value === schema.type
  }
}

/**
 * Schema errors with one entry per offending field. typebox reports every
 * branch of a failed union; this walk picks the branch the value selects
 * (by its discriminator, or by JSON type) and reports only that branch.
 */
function schemaErrors(schema: SchemaNode, value: unknown, at: string): ValidationError[] {
  if (schema.anyOf) return unionErrors(schema, schema.anyOf, value, at)

  if (schema.type === 'object' && schema.properties) {
    if (!isRecord(value)) return [{ path: at, message: 'must be an object' }]
    const errors: ValidationError[] = []
    for (const [key, property] of Object.entries(schema.properties)) {
      if (key in value) errors.push(...schemaErrors(property, value[key], pointer(at, key)))
      else if (schema.required?.includes(key))
        errors.push({ path: pointer(at, key), message: 'is required' })
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties))
          errors.push({ path: pointer(at, key), message: 'is not a known property' })
      }
    }
    return errors
  }

  if (schema.type === 'array' && schema.items) {
    if (!Array.isArray(value)) return [{ path: at, message: 'must be an array' }]
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return [{ path: at, message: `must have at most ${String(schema.maxItems)} items` }]
    }
    const items = schema.items
    return value.flatMap((item, i) => schemaErrors(items, item, pointer(at, i)))
  }

  return Value.Errors(schema as TSchema, value).map((e) => ({
    path: at + e.instancePath,
    message: leafMessage(schema, e.keyword) ?? e.message
  }))
}

function leafMessage(schema: SchemaNode, keyword: string): string | undefined {
  if (keyword === 'pattern') return schema[PATTERN_MESSAGE_KEY]
  if (keyword === 'enum' && schema.enum) return `must be one of: ${schema.enum.join(', ')}`
  return undefined
}

function unionErrors(
  schema: SchemaNode,
  variants: SchemaNode[],
  value: unknown,
  at: string
): ValidationError[] {
  if (Value.Check(schema as TSchema, value)) return []

  const key = schema[DISCRIMINATOR_KEY]
  if (key !== undefined) {
    if (!isRecord(value)) return [{ path: at, message: 'must be an object' }]
    // A variant without the discriminator property is the one chosen when the value omits it.
    const variant = variants.find((v) => {
      const property = v.properties?.[key]
      return property
        ? key in value && Value.Check(property as TSchema, value[key])
        : !(key in value)
    })
    if (variant) return schemaErrors(variant, value, at)
    const allowed = variants.flatMap((v) => {
      const property = v.properties?.[key]
      return property ? (constsOf(property) ?? []) : []
    })
    return [
      {
        path: pointer(at, key),
        message: key in value ? `must be one of: ${allowed.join(', ')}` : 'is required'
      }
    ]
  }

  const consts = constsOf(schema)
  if (consts) return [{ path: at, message: `must be one of: ${consts.join(', ')}` }]

  const candidates = variants.filter((v) => acceptsType(v, value))
  if (candidates.length === 1) return schemaErrors(candidates[0], value, at)
  return [{ path: at, message: 'has an invalid type' }]
}

/** The schema reports a nested combinator as unknown properties; this names the actual mistake. */
function nestedCombinatorErrors(rule: unknown, at: string): ValidationError[] {
  if (!isRecord(rule)) return []
  const signals: [unknown, string][] = [[rule.signal, pointer(at, 'signal')]]
  if (Array.isArray(rule.gates)) {
    rule.gates.forEach((gate: unknown, i) => {
      if (isRecord(gate))
        signals.push([gate.signal, pointer(pointer(pointer(at, 'gates'), i), 'signal')])
    })
  }
  return signals.flatMap(([signal, signalAt]) => {
    if (!isRecord(signal) || !Array.isArray(signal.inputs)) return []
    return signal.inputs.flatMap((input: unknown, i) =>
      isRecord(input) && 'combinator' in input
        ? [
            {
              path: pointer(pointer(signalAt, 'inputs'), i),
              message: 'combinators cannot be nested'
            }
          ]
        : []
    )
  })
}

/** Schema errors with one entry per offending field, for documents other than a rule. */
export function checkSchema(schema: TSchema, input: unknown): ValidationError[] {
  return schemaCheck(schema, input, [])
}

function schemaCheck(
  schema: TSchema,
  input: unknown,
  nested: ValidationError[]
): ValidationError[] {
  const nestedAt = nested.map((e) => e.path)
  const errors = schemaErrors(schema as SchemaNode, input, '').filter(
    (e) => !nestedAt.some((p) => e.path === p || e.path.startsWith(`${p}/`))
  )
  return [...nested, ...errors]
}

// Signal K names every position-valued leaf `position`.
function isPositionPath(path: string): boolean {
  return path.split('.').at(-1) === 'position'
}

function pathErrors(path: string, at: string, wildcard: string | undefined): ValidationError[] {
  if (path.startsWith('vessels.'))
    return [{ path: at, message: 'must be relative to vessels.self' }]
  const count = wildcards(path)
  if (count > 1) return [{ path: at, message: 'may contain at most one wildcard segment' }]
  if (count === 1 && wildcard !== undefined) return [{ path: at, message: wildcard }]
  return []
}

function signalErrors(
  signal: Signal,
  at: string,
  wildcard: string | undefined,
  ctx: ValidationContext
): ValidationError[] {
  if (!('combinator' in signal)) return pathErrors(signal.path, pointer(at, 'path'), wildcard)

  const kind = signal.combinator
  const errors: ValidationError[] = []
  const inputsAt = pointer(at, 'inputs')
  if (TWO_INPUTS.has(kind) && signal.inputs.length !== 2) {
    errors.push({ path: inputsAt, message: `${kind} needs exactly two inputs` })
  } else if (signal.inputs.length < 2) {
    errors.push({ path: inputsAt, message: `${kind} needs at least two inputs` })
  }
  if (signal.angular === true && !ANGULAR_COMBINATORS.has(kind)) {
    errors.push({ path: pointer(at, 'angular'), message: `${kind} cannot wrap angles` })
  }

  signal.inputs.forEach((input, i) => {
    const inputAt = pointer(pointer(inputsAt, i), 'path')
    const pathError = pathErrors(input.path, inputAt, 'combinator inputs cannot contain a wildcard')
    if (pathError.length > 0) {
      errors.push(...pathError)
    } else if (POSITION_COMBINATORS.has(kind) !== isPositionPath(input.path)) {
      errors.push({
        path: inputAt,
        message: POSITION_COMBINATORS.has(kind)
          ? `${kind} needs a position path`
          : 'positions can only be combined by distance or positionSpread'
      })
    } else if (signal.angular === true) {
      const units = ctx.pathInfo?.(input.path)?.units
      if (units !== undefined && units !== 'rad') {
        errors.push({ path: inputAt, message: angularUnitsMessage(units) })
      }
    }
  })
  return errors
}

function limitErrors(
  limit: Limit,
  signal: Signal,
  at: string,
  wildcard: string | undefined
): ValidationError[] {
  if (limit.kind !== 'zone') return []
  if (limit.path !== undefined) return pathErrors(limit.path, pointer(at, 'path'), wildcard)
  if ('combinator' in signal) {
    return [
      {
        path: pointer(at, 'path'),
        message: 'a zone limit on a combined signal must name the path whose zones it uses'
      }
    ]
  }
  return []
}

function valueRequired(
  op: string,
  hasValue: boolean,
  needsValue: boolean,
  at: string
): ValidationError[] {
  if (needsValue && !hasValue)
    return [{ path: pointer(at, 'value'), message: `${op} needs a value` }]
  if (!needsValue && hasValue)
    return [{ path: pointer(at, 'value'), message: `${op} takes no value` }]
  return []
}

function eventErrors(event: Event, at: string): ValidationError[] {
  return valueRequired(event.op, event.value !== undefined, event.op === 'changesTo', at)
}

function detectorErrors(rule: Rule, wildcard: string | undefined): ValidationError[] {
  const d = rule.detector
  const at = '/detector'
  switch (d.type) {
    case 'match': {
      const errors = valueRequired(
        d.op,
        d.value !== undefined,
        ['equals', 'notEquals', 'changesTo'].includes(d.op),
        at
      )
      if (d.duration !== undefined && (d.op === 'changesTo' || d.op === 'decreases')) {
        errors.push({
          path: pointer(at, 'duration'),
          message: `${d.op} is a transition and takes no duration`
        })
      }
      if (d.op === 'timedOut') errors.push(...timeoutErrors(rule, d.duration))
      return errors
    }
    case 'sustained':
    case 'projection':
      return limitErrors(d.limit, rule.signal, pointer(at, 'limit'), wildcard)
    case 'accumulator': {
      const errors = d.resetOn ? eventErrors(d.resetOn, pointer(at, 'resetOn')) : []
      if (
        d.while &&
        (d.while.op === 'above' || d.while.op === 'below') &&
        typeof d.while.value !== 'number'
      ) {
        errors.push({ path: '/detector/while/value', message: `${d.while.op} needs a number` })
      }
      return errors
    }
    case 'count':
    case 'absence':
      return eventErrors(d.event, pointer(at, 'event'))
    case 'slope':
      return []
  }
}

// Core emits its timed-out marker only for numeric paths, so a timeout rule
// elsewhere could never fire.
function timeoutErrors(rule: Rule, duration: number | undefined): ValidationError[] {
  if ('combinator' in rule.signal) {
    return [
      {
        path: '/detector/op',
        message: 'a timeout rule watches a single path, not a combined signal'
      }
    ]
  }
  if (duration === undefined || duration === 0) {
    return [{ path: '/detector/duration', message: 'a timeout rule needs a duration' }]
  }
  return []
}

function timeoutTypeErrors(rule: Rule, ctx: ValidationContext): ValidationError[] {
  if (
    rule.detector.type !== 'match' ||
    rule.detector.op !== 'timedOut' ||
    'combinator' in rule.signal
  )
    return []
  const valueType = ctx.pathInfo?.(rule.signal.path)?.valueType
  if (valueType === 'boolean' || valueType === 'string') {
    return [{ path: '/signal/path', message: timeoutValueTypeMessage(valueType) }]
  }
  return []
}

// A zone-limit rule's priority comes from its zone levels rather than from the
// rule: a sustained rule escalates through them, a projection keeps the level
// it names.
function priorityErrors(rule: Rule): ValidationError[] {
  const zoned = zoneLimitOf(rule) !== undefined
  if (zoned && rule.priority !== undefined) {
    return [
      {
        path: '/priority',
        message: 'a zone-limit rule takes its priority from the zone level it is in'
      }
    ]
  }
  if (!zoned && rule.priority === undefined) {
    return [{ path: '/priority', message: 'a rule without a zone limit needs a priority' }]
  }
  return []
}

// A latching rule holds no alert across a restart, so its condition must be
// an event, which replayed values cannot produce. A lasting condition is seen
// again after a restart and would be announced as a new occurrence.
function latchingErrors(rule: Rule): ValidationError[] {
  if (rule.latching !== true) return []
  const d = rule.detector
  const event =
    d.type === 'count' || (d.type === 'match' && (d.op === 'changesTo' || d.op === 'decreases'))
  if (event) return []
  return [
    {
      path: '/latching',
      message:
        'only an event count or a changesTo or decreases match can latch; ' +
        'a lasting condition already waits for acknowledgment after its return to normal'
    }
  ]
}

function semanticErrors(rule: Rule, ctx: ValidationContext): ValidationError[] {
  const signalWildcard = !('combinator' in rule.signal) && wildcards(rule.signal.path) > 0
  // A wildcard elsewhere in the rule binds to the signal's instance, so it needs one to bind to.
  const bound = signalWildcard ? undefined : 'a wildcard here needs a wildcard in the rule signal'

  const errors = [
    ...signalErrors(rule.signal, '/signal', undefined, ctx),
    ...priorityErrors(rule),
    ...latchingErrors(rule),
    ...detectorErrors(rule, bound),
    ...timeoutTypeErrors(rule, ctx)
  ]
  rule.gates?.forEach((gate, i) => {
    const at = pointer('/gates', i)
    errors.push(...signalErrors(gate.signal, pointer(at, 'signal'), bound, ctx))
    errors.push(...limitErrors(gate.limit, gate.signal, pointer(at, 'limit'), bound))
  })
  return errors
}

/** Validates one rule definition and returns it typed. */
export function validateRule(input: unknown, ctx: ValidationContext = {}): Result<Rule> {
  const missing = conditionMissing(input)
  const errors = schemaCheck(RuleSchema, input, nestedCombinatorErrors(input, ''))
  if (errors.length > 0) return fail(missing === undefined ? errors : [missing, ...errors])
  const rule = input as Rule
  const semantic = [
    ...(missing === undefined ? alertPathErrors(rule) : [missing]),
    ...semanticErrors(rule, ctx)
  ]
  return semantic.length > 0 ? fail(semantic) : { ok: true, value: rule }
}
