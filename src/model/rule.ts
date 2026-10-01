import Type, { type Static, type TNumberOptions } from 'typebox'
import { MAX_ALERT_PATH_LENGTH, SEGMENT_CHARS } from '../alerts/paths.js'

export const MAX_DURATION_S = 24 * 3600
export const MAX_RULES = 500
export const MAX_INSTANCES = 64
export const MAX_SLUG_LENGTH = 64
export const MAX_COMBINATOR_INPUTS = 16
export const MAX_GATES = 8
export const MAX_VERSION_LENGTH = 64
/** Longest instance or source a template pick names; a Signal K path is at most this long. */
export const MAX_PICK_LENGTH = 255

/**
 * How the panel converts a numeric field between SI and display units.
 * `absolute` uses the signal's full display-unit formula, `interval` only its
 * linear part (2 °C of hysteresis is 2 K, not 275.15 K). `duration` is seconds,
 * `count` is unitless, and `accumulated` depends on the accumulator's measure:
 * seconds for time, signal unit times seconds for an integral.
 */
export type Quantity = 'absolute' | 'interval' | 'duration' | 'count' | 'accumulated'

/** Schema keyword carrying a numeric field's {@link Quantity}. */
export const QUANTITY_KEY = 'x-quantity'

/** Schema keyword naming the property that selects a union's variant. */
export const DISCRIMINATOR_KEY = 'x-discriminator'

/** Schema keyword with the message shown when a string does not match its pattern. */
export const PATTERN_MESSAGE_KEY = 'x-pattern-message'

export const SLUG_PATTERN = '^[a-z0-9]+(-[a-z0-9]+)*$'
export const SLUG_MESSAGE = 'must be lowercase letters and digits separated by single hyphens'

// One segment of a path, other than the wildcard.
const PATH_SEGMENT = '[^.\\s*]+'

// A dot-separated path relative to vessels.self; `*` stands alone as a segment.
const PATH_PATTERN = `^(${PATH_SEGMENT}|\\*)(\\.(${PATH_SEGMENT}|\\*))*$`

/** An instance pick: the one path segment `${instance}` stands for. */
export const INSTANCE_PICK_PATTERN = `^${PATH_SEGMENT}$`
export const INSTANCE_PICK_MESSAGE = 'must be one path segment, without dots, whitespace or *'

export const COMBINATORS = [
  'difference',
  'absDifference',
  'ratio',
  'spread',
  'mean',
  'median',
  'distance',
  'positionSpread'
] as const
export type CombinatorKind = (typeof COMBINATORS)[number]

export const PRIORITIES = ['emergency', 'alarm', 'warning', 'caution'] as const
export type Priority = (typeof PRIORITIES)[number]

/** The `meta.zones` states that raise an alert; normal and nominal raise nothing. */
export const ZONE_LEVELS = ['alert', 'warn', 'alarm', 'emergency'] as const
export type ZoneLevel = (typeof ZONE_LEVELS)[number]

/** The priority a zone-limit rule raises at while a zone level is the most severe it holds. */
export const LEVEL_PRIORITY: Readonly<Record<ZoneLevel, Priority>> = {
  alert: 'caution',
  warn: 'warning',
  alarm: 'alarm',
  emergency: 'emergency'
}

const num = (quantity: Quantity, options?: TNumberOptions) =>
  Type.Number({ ...options, [QUANTITY_KEY]: quantity })

export const slugSchema = () =>
  Type.String({
    maxLength: MAX_SLUG_LENGTH,
    pattern: SLUG_PATTERN,
    [PATTERN_MESSAGE_KEY]: SLUG_MESSAGE
  })

const duration = () => num('duration', { minimum: 0, maximum: MAX_DURATION_S })
const timeWindow = () => num('duration', { exclusiveMinimum: 0, maximum: MAX_DURATION_S })
const nonNegative = (quantity: Quantity) => num(quantity, { minimum: 0 })
const closed = { additionalProperties: false }

const PathSchema = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: PATH_PATTERN,
  [PATTERN_MESSAGE_KEY]: 'must be a dot-separated path in which * stands alone as a segment'
})

export const CONDITION_MESSAGE = 'must be one alert path segment: letters, digits, _ and -'

/** A condition name: one segment core accepts in an alert path. */
export const conditionSchema = () =>
  Type.String({
    maxLength: MAX_ALERT_PATH_LENGTH,
    pattern: `^${SEGMENT_CHARS}$`,
    [PATTERN_MESSAGE_KEY]: CONDITION_MESSAGE
  })

const PathInputSchema = Type.Object(
  { path: PathSchema, source: Type.Optional(Type.String({ minLength: 1 })) },
  closed
)

const CombinatorSchema = Type.Object(
  {
    combinator: Type.Enum(COMBINATORS),
    inputs: Type.Array(PathInputSchema, { maxItems: MAX_COMBINATOR_INPUTS }),
    angular: Type.Optional(Type.Boolean())
  },
  closed
)

const SignalSchema = Type.Union([PathInputSchema, CombinatorSchema], {
  [DISCRIMINATOR_KEY]: 'combinator'
})

const LimitSchema = Type.Union(
  [
    Type.Object({ kind: Type.Literal('fixed'), value: num('absolute') }, closed),
    Type.Object(
      {
        kind: Type.Literal('zone'),
        level: Type.Enum(ZONE_LEVELS),
        path: Type.Optional(PathSchema)
      },
      closed
    )
  ],
  { [DISCRIMINATOR_KEY]: 'kind' }
)

const ValueSchema = Type.Union([num('absolute'), Type.String(), Type.Boolean()])

const comparisonFields = {
  direction: Type.Enum(['above', 'below']),
  limit: LimitSchema,
  duration: Type.Optional(duration()),
  hysteresis: Type.Optional(nonNegative('interval')),
  clearDuration: Type.Optional(duration())
}

const StateConditionSchema = Type.Object(
  { op: Type.Enum(['above', 'below', 'equals', 'notEquals']), value: ValueSchema },
  closed
)

const EventSchema = Type.Object(
  { op: Type.Enum(['changes', 'changesTo', 'decreases']), value: Type.Optional(ValueSchema) },
  closed
)

const DetectorSchema = Type.Union(
  [
    Type.Object(
      {
        type: Type.Literal('match'),
        op: Type.Enum(['equals', 'notEquals', 'changesTo', 'decreases', 'timedOut']),
        value: Type.Optional(ValueSchema),
        duration: Type.Optional(duration())
      },
      closed
    ),
    Type.Object({ type: Type.Literal('sustained'), ...comparisonFields }, closed),
    Type.Object(
      {
        type: Type.Literal('slope'),
        direction: Type.Enum(['rising', 'falling']),
        window: timeWindow(),
        limit: num('interval', { exclusiveMinimum: 0 })
      },
      closed
    ),
    Type.Object(
      {
        type: Type.Literal('projection'),
        direction: Type.Enum(['rising', 'falling']),
        limit: LimitSchema,
        window: timeWindow(),
        horizon: timeWindow()
      },
      closed
    ),
    Type.Object(
      {
        type: Type.Literal('accumulator'),
        measure: Type.Enum(['time', 'integral']),
        while: Type.Optional(StateConditionSchema),
        resetOn: Type.Optional(EventSchema),
        limit: num('accumulated', { exclusiveMinimum: 0 })
      },
      closed
    ),
    Type.Object(
      {
        type: Type.Literal('count'),
        event: EventSchema,
        window: timeWindow(),
        limit: num('count', { minimum: 1, multipleOf: 1 })
      },
      closed
    ),
    Type.Object({ type: Type.Literal('absence'), event: EventSchema, within: timeWindow() }, closed)
  ],
  { [DISCRIMINATOR_KEY]: 'type' }
)

const GateSchema = Type.Object({ signal: SignalSchema, ...comparisonFields }, closed)

// The pattern alone requires a character, so an empty instance gets one error.
const InstancePickSchema = Type.String({
  maxLength: MAX_PICK_LENGTH,
  pattern: INSTANCE_PICK_PATTERN,
  [PATTERN_MESSAGE_KEY]: INSTANCE_PICK_MESSAGE
})
const SourcePickSchema = Type.String({ minLength: 1, maxLength: MAX_PICK_LENGTH })

const TemplateRecordSchema = Type.Object(
  {
    set: slugSchema(),
    id: slugSchema(),
    version: Type.String({ minLength: 1, maxLength: MAX_VERSION_LENGTH }),
    pick: Type.Object(
      {
        instance: Type.Optional(InstancePickSchema),
        source: Type.Optional(SourcePickSchema)
      },
      closed
    )
  },
  closed
)

export const RuleSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    slug: slugSchema(),
    /**
     * The condition name, the last segment of the rule's alert path in core.
     * The alert path, without the `alerts.` prefix, is this name under the
     * parent the input gives (`alertPathOf`): `voltageLow` under
     * `electrical.batteries.house`. Only the name is the rule's to choose;
     * the parent always follows the input, and a wildcard in it is filled by
     * each instance. Left out, the name is the default of the input's leaf
     * and the detector (`defaultCondition`), and follows edits to them;
     * given, it is kept through every edit. A combined signal or an input
     * ending in a wildcard has no leaf to name it by, so it needs one.
     */
    condition: Type.Optional(conditionSchema()),
    message: Type.String({ minLength: 1, maxLength: 500 }),
    /** Required unless the detector has a zone limit, whose levels set the priority. */
    priority: Type.Optional(Type.Enum(PRIORITIES)),
    /**
     * Accepted only on detectors whose condition is an event: a count, or a
     * `changesTo` or `decreases` match. Each time the condition becomes
     * active the alert is raised once and waits for acknowledgment. A
     * lasting condition cannot latch: a restart would see it again and
     * raise it as a new occurrence, and at a priority that needs
     * acknowledgment its alert already waits for it after the condition
     * returns to normal.
     */
    latching: Type.Optional(Type.Boolean()),
    signal: SignalSchema,
    detector: DetectorSchema,
    gates: Type.Optional(Type.Array(GateSchema, { maxItems: MAX_GATES })),
    /**
     * The template the rule was created from, as information only: nothing
     * reads it to evaluate the rule, so changing or removing the template
     * never affects the rule.
     */
    template: Type.Optional(TemplateRecordSchema)
  },
  closed
)

export type Rule = Static<typeof RuleSchema>
export type Signal = Static<typeof SignalSchema>
export type PathInput = Static<typeof PathInputSchema>
export type Limit = Static<typeof LimitSchema>
export type Detector = Static<typeof DetectorSchema>
export type Gate = Static<typeof GateSchema>
export type Event = Static<typeof EventSchema>
export type TemplateRecord = Static<typeof TemplateRecordSchema>
export type TemplatePick = TemplateRecord['pick']

export type ZoneLimit = Extract<Limit, { kind: 'zone' }>

/** The zone limit of the rule's detector; a gate's zone limit does not count. */
export function zoneLimitOf(rule: Pick<Rule, 'detector'>): ZoneLimit | undefined {
  const d = rule.detector
  if (d.type !== 'sustained' && d.type !== 'projection') return undefined
  return d.limit.kind === 'zone' ? d.limit : undefined
}

/**
 * The priority of a rule's alert while it holds a zone level, or while it
 * holds its own level when none is given. A rule without a zone limit has one
 * priority.
 */
export function priorityOf(rule: Rule, level?: ZoneLevel): Priority {
  const held = level ?? zoneLimitOf(rule)?.level
  if (held !== undefined) return LEVEL_PRIORITY[held]
  // Validation requires a priority on every rule without a zone limit.
  if (rule.priority === undefined) throw new Error(`rule ${rule.slug} has no priority`)
  return rule.priority
}
