import Type, { type Static, type TNumberOptions, type TProperties } from 'typebox'
import { MAX_ALERT_PATH_LENGTH, SEGMENT_CHARS } from '../alerts/paths.js'
import { ZONE_LEVELS, type ZoneLevel } from './zoneLevels.js'

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

// One segment of a path, other than the wildcard; `#` starts a field's pointer.
const PATH_SEGMENT = '[^.\\s*#]+'

// A dot-separated path relative to vessels.self, in which `*` stands alone as
// a segment, optionally followed by `#` and a pointer to a field of its value.
// The pointer is checked with the rule, so that its errors can say what is
// wrong with it.
const PATH_PATTERN = `^(${PATH_SEGMENT}|\\*)(\\.(${PATH_SEGMENT}|\\*))*(#[\\s\\S]*)?$`

/** A slot's pick: the one path segment its placeholder, such as `${instance}`, stands for. */
export const SLOT_PICK_PATTERN = `^${PATH_SEGMENT}$`
export const SLOT_PICK_MESSAGE = 'must be one path segment, without dots, whitespace, * or #'

/** Most slots a template declares. */
export const MAX_SLOTS = 4
export const MAX_SLOT_NAME_LENGTH = 32
/** A slot's name, which keys its pick: a letter, then letters and digits. */
export const SLOT_NAME_PATTERN = '^[A-Za-z][A-Za-z0-9]*$'
export const SLOT_NAME_MESSAGE = 'must be a letter followed by letters and digits'
/** The pick key of an open source, which no slot may take. */
export const SOURCE_PICK = 'source'

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

/** A priority's severity: a more severe priority ranks higher. */
export function severityOf(priority: Priority): number {
  // PRIORITIES lists the most severe first.
  return PRIORITIES.length - PRIORITIES.indexOf(priority)
}

export { ZONE_LEVELS, type ZoneLevel } from './zoneLevels.js'

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

const ZoneLimitSchema = Type.Object(
  {
    kind: Type.Literal('zone'),
    level: Type.Enum(ZONE_LEVELS),
    path: Type.Optional(PathSchema)
  },
  closed
)

const LimitSchema = Type.Union(
  [Type.Object({ kind: Type.Literal('fixed'), value: num('absolute') }, closed), ZoneLimitSchema],
  { [DISCRIMINATOR_KEY]: 'kind' }
)

const PrioritySchema = Type.Enum(PRIORITIES)

/**
 * A rule's steps, in the order the alert climbs them: each holds the
 * detector's kind of limit and the priority the alert has once the condition
 * reaches it. The bounds and the ordering are checked with the rest of the
 * rule, so that each error points at the step that breaks them.
 */
const stepArray = <P extends TProperties>(limit: P) =>
  Type.Array(Type.Object({ ...limit, priority: PrioritySchema }, closed))

const ValueSchema = Type.Union([num('absolute'), Type.String(), Type.Boolean()])

const timingFields = {
  duration: Type.Optional(duration()),
  hysteresis: Type.Optional(nonNegative('interval'))
}

/**
 * A value limit's steps, or the steps the path's `meta.zones` give from a
 * zone level upwards; a rule has one or the other.
 */
const valueLimitFields = {
  steps: Type.Optional(stepArray({ limit: num('absolute') })),
  limit: Type.Optional(ZoneLimitSchema)
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
        steps: stepArray({ value: Type.Optional(ValueSchema) }),
        duration: Type.Optional(duration())
      },
      closed
    ),
    Type.Object(
      {
        type: Type.Literal('sustained'),
        direction: Type.Enum(['above', 'below']),
        ...valueLimitFields,
        ...timingFields
      },
      closed
    ),
    Type.Object(
      {
        type: Type.Literal('outside'),
        steps: stepArray({ low: num('absolute'), high: num('absolute') }),
        ...timingFields
      },
      closed
    ),
    Type.Object(
      {
        type: Type.Literal('slope'),
        direction: Type.Enum(['rising', 'falling']),
        window: timeWindow(),
        steps: stepArray({ limit: num('interval', { exclusiveMinimum: 0 }) })
      },
      closed
    ),
    Type.Object(
      {
        type: Type.Literal('projection'),
        direction: Type.Enum(['rising', 'falling']),
        ...valueLimitFields,
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
        steps: stepArray({ limit: num('accumulated', { exclusiveMinimum: 0 }) })
      },
      closed
    ),
    Type.Object(
      {
        type: Type.Literal('count'),
        event: EventSchema,
        window: timeWindow(),
        steps: stepArray({ limit: num('count', { minimum: 1, multipleOf: 1 }) })
      },
      closed
    ),
    Type.Object(
      {
        type: Type.Literal('absence'),
        event: EventSchema,
        steps: stepArray({ within: timeWindow() })
      },
      closed
    )
  ],
  { [DISCRIMINATOR_KEY]: 'type' }
)

// A gate is a plain condition: one limit, no steps, and no hysteresis or
// delay. A rule back in use restarts its detector, so the rule's duration
// spaces the alerts of a flickering gate; an accumulator, which keeps
// accumulating while out of use, and a rule with no duration raise again as
// soon as the gate holds, so only the gate's own duration spaces those.
const GateSchema = Type.Object(
  {
    signal: SignalSchema,
    direction: Type.Enum(['above', 'below']),
    limit: LimitSchema,
    duration: Type.Optional(duration())
  },
  closed
)

// The pattern alone requires a character, so an empty pick gets one error.
const SlotPickSchema = Type.String({
  maxLength: MAX_PICK_LENGTH,
  pattern: SLOT_PICK_PATTERN,
  [PATTERN_MESSAGE_KEY]: SLOT_PICK_MESSAGE
})
const SourcePickSchema = Type.String({ minLength: 1, maxLength: MAX_PICK_LENGTH })

/**
 * What a use of a template picked: each slot's instance under the slot's
 * name, and the source when the template leaves it open. A single-slot
 * template written with `open: [instance]` has the one slot `instance`.
 */
export type TemplatePick = Partial<Record<string, string>>

// Any slot name but the source's, so the source keeps its own schema.
const SLOT_PICK_KEY = `^(?!${SOURCE_PICK}$)${SLOT_NAME_PATTERN.slice(1)}`

const TemplatePickSchema = Type.Unsafe<TemplatePick>(
  Type.Object(
    { [SOURCE_PICK]: Type.Optional(SourcePickSchema) },
    {
      ...closed,
      patternProperties: { [SLOT_PICK_KEY]: SlotPickSchema },
      maxProperties: MAX_SLOTS + 1
    }
  )
)

const TemplateRecordSchema = Type.Object(
  {
    set: slugSchema(),
    id: slugSchema(),
    version: Type.String({ minLength: 1, maxLength: MAX_VERSION_LENGTH }),
    pick: TemplatePickSchema
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

export type ZoneLimit = Static<typeof ZoneLimitSchema>

/** A rule's step: the detector's kind of limit and the priority it raises at. */
export type Step = NonNullable<Extract<Detector, { steps?: unknown }>['steps']>[number]

/** The zone limit of the rule's detector; a gate's zone limit does not count. */
export function zoneLimitOf(rule: Pick<Rule, 'detector'>): ZoneLimit | undefined {
  const d = rule.detector
  return d.type === 'sustained' || d.type === 'projection' ? d.limit : undefined
}

/**
 * The steps a rule stores; empty for a zone-limit rule, whose steps come from
 * the path's zones.
 */
export function stepsOf(rule: Pick<Rule, 'detector'>): readonly Step[] {
  return rule.detector.steps ?? []
}

/** The priority an alert is raised at when the condition reaches only the first step. */
export function firstPriority(rule: Pick<Rule, 'detector' | 'slug'>): Priority {
  const zone = zoneLimitOf(rule)
  if (zone !== undefined) return LEVEL_PRIORITY[zone.level]
  // Validation requires a zone limit or at least one step.
  const first = stepsOf(rule).at(0)
  if (first === undefined) throw new Error(`rule ${rule.slug} has no steps`)
  return first.priority
}
