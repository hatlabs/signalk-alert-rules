/**
 * The authoring form's state and its conversion to and from a rule.
 *
 * The form holds what the user typed: numbers as text in the display unit of
 * the path they apply to, durations as an amount and a unit. `toRule` turns
 * that into an SI rule, and `fromRule` shows a stored rule the same way, so a
 * rule survives the round trip. Every detector's fields live side by side,
 * and saving reads only those of the detector chosen. The steps are the
 * exception: what a step's limit means depends on the detector, so a change
 * of detector that changes it starts the steps afresh (`withDetector`).
 * Save paths go through `toSavedRule` (message.ts), which fills in an empty
 * message before `toRule` reads the form.
 */
import type {
  CombinatorKind,
  Detector,
  Event,
  Gate,
  Limit,
  PathInput,
  Priority,
  Rule,
  Signal,
  Step,
  TemplateRecord,
  ZoneLevel
} from '../../model/rule'
import { ZONE_LEVELS } from '../../model/zoneLevels'
import { alertParent, defaultCondition } from '../../alerts/paths'
import { isRecord, type FieldError } from '../api'
import {
  isWildcardPath,
  measureSettled,
  POSITION_KINDS,
  signalMeasure,
  type Measure,
  type SignalShape,
  type UnitLookup
} from '../signalUnits'
import { formatNumber } from '../../format'
import { converts, fromSI, toSI, type DisplayUnit, type QuantityKind } from '../units'

export { MAX_SLUG, slugify } from '../../templates/instantiate'

// The model's own values live in modules that build the rule schema, which
// the panel does not bundle; a test keeps these equal to them.
export const COMBINATOR_KINDS = [
  'difference',
  'absDifference',
  'ratio',
  'spread',
  'mean',
  'median',
  'distance',
  'positionSpread'
] as const satisfies readonly CombinatorKind[]
/** Every value of a choice, listed by a record so the compiler finds one left out. */
function every<T extends string>(all: Readonly<Record<T, true>>): readonly T[] {
  return Object.keys(all) as T[]
}

export const PRIORITY_LEVELS = every<Priority>({
  emergency: true,
  alarm: true,
  warning: true,
  caution: true
})
export const MAX_INPUTS = 16
export const MAX_GATES = 8

export const TWO_INPUT_KINDS: ReadonlySet<CombinatorKind> = new Set([
  'difference',
  'absDifference',
  'ratio',
  'distance'
])
export const ANGULAR_KINDS: ReadonlySet<CombinatorKind> = new Set([
  'difference',
  'absDifference',
  'mean',
  'spread'
])

export type DetectorType = Detector['type']
const DETECTOR_TYPES: Readonly<Record<DetectorType, true>> = {
  sustained: true,
  outside: true,
  slope: true,
  projection: true,
  match: true,
  accumulator: true,
  count: true,
  absence: true
}
export type MatchOp = Extract<Detector, { type: 'match' }>['op']
export type EventOp = Event['op']
type StateOp = 'above' | 'below' | 'equals' | 'notEquals'

export type DurationUnit = 's' | 'min' | 'h'
const DURATION_FACTORS: Readonly<Record<DurationUnit, number>> = { s: 1, min: 60, h: 3600 }

export interface DurationField {
  amount: string
  unit: DurationUnit
}

/** A match, state or event value: a number in the display unit, text, or a boolean. */
export type ValueType = 'number' | 'text' | 'true' | 'false'
export interface ValueField {
  type: ValueType
  text: string
  exact?: Exacts<'text'>
}

export interface SlotForm {
  path: string
  /** Empty for the preferred source. */
  source: string
}

export interface SignalForm {
  mode: 'single' | 'combine'
  combinator: CombinatorKind
  angular: boolean
  /** One slot for a single path. */
  slots: SlotForm[]
}

export interface LimitForm {
  kind: 'fixed' | 'zone'
  value: string
  level: ZoneLevel | ''
  /** A zone limit's path; empty for the signal's own. */
  path: string
  exact?: Exacts<'value'>
}

export interface EventForm {
  op: EventOp | ''
  value: ValueField
}

export interface DetectorForm {
  type: DetectorType | ''
  matchOp: MatchOp | ''
  direction: 'above' | 'below' | ''
  trend: 'rising' | 'falling' | ''
  /** A zone limit, in place of the steps, while its kind is `zone`; `fixed` means the steps. */
  limit: LimitForm
  measure: 'time' | 'integral' | ''
  useWhile: boolean
  whileOp: StateOp | ''
  whileValue: ValueField
  useResetOn: boolean
  resetOn: EventForm
  event: EventForm
  duration: DurationField
  window: DurationField
  horizon: DurationField
  hysteresis: string
  exact?: Exacts<'hysteresis'>
}

export interface GateForm {
  signal: SignalForm
  direction: 'above' | 'below' | ''
  limit: LimitForm
  duration: DurationField
}

/**
 * One step of the climb: a priority and the limit it is reached at. Which
 * field holds the limit depends on the detector (`stepQuantity`).
 */
export interface StepForm {
  priority: Priority | ''
  /** A number in the unit its quantity is shown in. */
  limit: string
  /** A range's limits, numbers in the value's display unit. */
  low: string
  high: string
  /** An accumulated time, or an absence's window. */
  duration: DurationField
  /** A match's value. */
  value: ValueField
  exact?: Exacts<'limit' | 'low' | 'high'>
}

/** What a step's limit is, which decides how it is entered and stored. */
export type StepQuantity =
  | 'value'
  /** A low and a high value. */
  | 'range'
  | 'slope'
  | 'count'
  | 'integral'
  | 'time'
  | 'within'
  | 'match'
  /** A match that takes no value: the step is its priority alone. */
  | 'none'

/** A rule has one to four steps, one per priority; see docs/rules.md. */
export const MAX_STEPS = 4

export interface RuleForm {
  name: string
  slug: string
  /** The slug is still derived from the name: a new rule whose slug nobody edited. */
  slugFollowsName: boolean
  /**
   * The condition name as typed, the last segment of the alert path. Empty,
   * the rule stores none and its name follows the default its input and
   * detector give.
   */
  condition: string
  message: string
  /** The message is still written from the rule: a new rule whose message nobody edited. */
  messageFollows: boolean
  /** Likewise the name. */
  nameFollows: boolean
  /** The climb, in order; unused while the detector has a zone limit. */
  steps: StepForm[]
  latching: boolean
  signal: SignalForm
  detector: DetectorForm
  gates: GateForm[]
  /** The template the rule was made from, which the form does not show and an edit keeps. */
  template?: TemplateRecord
}

const UNIT_ONE: DisplayUnit = { symbol: '', scale: 1, offset: 0, si: true }

const noDuration = (): DurationField => ({ amount: '', unit: 's' })
const noValue = (): ValueField => ({ type: 'number', text: '' })
const noLimit = (): LimitForm => ({ kind: 'fixed', value: '', level: 'warn', path: '' })
const noSlot = (): SlotForm => ({ path: '', source: '' })

export function emptyStep(priority: Priority | '' = ''): StepForm {
  return { priority, limit: '', low: '', high: '', duration: noDuration(), value: noValue() }
}

export function emptySignal(): SignalForm {
  return { mode: 'single', combinator: 'difference', angular: false, slots: [noSlot()] }
}

export function emptyGate(): GateForm {
  return {
    signal: emptySignal(),
    direction: 'above',
    limit: noLimit(),
    duration: noDuration()
  }
}

export function emptyForm(): RuleForm {
  return {
    name: '',
    slug: '',
    slugFollowsName: true,
    condition: '',
    message: '',
    messageFollows: true,
    nameFollows: true,
    steps: [emptyStep()],
    latching: false,
    signal: emptySignal(),
    detector: {
      type: '',
      matchOp: '',
      direction: '',
      trend: '',
      limit: noLimit(),
      measure: '',
      useWhile: false,
      whileOp: 'above',
      whileValue: noValue(),
      useResetOn: false,
      // Any change would reset a numeric total on nearly every sample.
      resetOn: { op: 'changesTo', value: noValue() },
      event: { op: 'changes', value: noValue() },
      duration: noDuration(),
      window: noDuration(),
      horizon: noDuration(),
      hysteresis: ''
    },
    gates: []
  }
}

// ---- signal slots ----

function slotBounds(kind: CombinatorKind): [number, number] {
  return TWO_INPUT_KINDS.has(kind) ? [2, 2] : [2, MAX_INPUTS]
}

function fitSlots(slots: SlotForm[], [min, max]: [number, number]): SlotForm[] {
  const kept = slots.slice(0, max)
  while (kept.length < min) kept.push(noSlot())
  return kept
}

export function setMode(signal: SignalForm, mode: SignalForm['mode']): SignalForm {
  if (mode === 'single') return { ...signal, mode, slots: [signal.slots[0] ?? noSlot()] }
  return { ...signal, mode, slots: fitSlots(signal.slots, slotBounds(signal.combinator)) }
}

/** A combinator kind sets the slot count, or bounds it. */
export function setCombinator(signal: SignalForm, combinator: CombinatorKind): SignalForm {
  return { ...signal, combinator, slots: fitSlots(signal.slots, slotBounds(combinator)) }
}

export function canAddSlot(signal: SignalForm): boolean {
  return signal.mode === 'combine' && signal.slots.length < slotBounds(signal.combinator)[1]
}

export function canRemoveSlot(signal: SignalForm): boolean {
  return signal.mode === 'combine' && signal.slots.length > slotBounds(signal.combinator)[0]
}

export function signalShape(signal: SignalForm): SignalShape {
  return signal.mode === 'single'
    ? { paths: [signal.slots[0]?.path ?? ''] }
    : { paths: signal.slots.map((s) => s.path), combinator: signal.combinator }
}

export function hasWildcard(signal: SignalForm): boolean {
  return signal.mode === 'single' && isWildcardPath(signal.slots[0]?.path ?? '')
}

/**
 * Per slot, why its path cannot be combined with the others: combined
 * inputs must share a unit, except positions, which have none.
 */
export function slotUnitErrors(signal: SignalForm, units: UnitLookup): (string | undefined)[] {
  if (signal.mode === 'single' || POSITION_KINDS.has(signal.combinator)) {
    return signal.slots.map(() => undefined)
  }
  const known = signal.slots.map((s) => units.entry(s.path)?.units)
  const first = known.find((u) => u !== undefined)
  return known.map((u) =>
    u !== undefined && first !== undefined && u !== first
      ? `is in ${u}, the other inputs in ${first}`
      : undefined
  )
}

// ---- detector facts ----

export function isZoneLimited(detector: DetectorForm): boolean {
  return (
    (detector.type === 'sustained' || detector.type === 'projection') &&
    detector.limit.kind === 'zone'
  )
}

/** Only an event can latch; see `latching` in src/model/rule.ts. */
export function canLatch(detector: DetectorForm): boolean {
  return (
    detector.type === 'count' ||
    (detector.type === 'match' &&
      (detector.matchOp === 'changesTo' || detector.matchOp === 'decreases'))
  )
}

export function matchTakesValue(op: MatchOp | ''): boolean {
  return op === 'equals' || op === 'notEquals' || op === 'changesTo'
}

export function matchTakesDuration(op: MatchOp | ''): boolean {
  return op === 'equals' || op === 'notEquals' || op === 'timedOut'
}

/** Whether the condition must hold for a while before a step is reached. */
export function holdsFor(d: DetectorForm): boolean {
  return (
    d.type === 'sustained' ||
    d.type === 'outside' ||
    (d.type === 'match' && matchTakesDuration(d.matchOp))
  )
}

/** What the detector's step limits are; undefined until the detector is chosen. */
export function stepQuantity(d: DetectorForm): StepQuantity | undefined {
  switch (d.type) {
    case '':
      return undefined
    case 'sustained':
    case 'projection':
      return 'value'
    case 'outside':
      return 'range'
    case 'slope':
      return 'slope'
    case 'count':
      return 'count'
    case 'absence':
      return 'within'
    case 'accumulator':
      return d.measure === 'time' ? 'time' : d.measure === 'integral' ? 'integral' : undefined
    case 'match':
      if (d.matchOp === '') return undefined
      return matchTakesValue(d.matchOp) ? 'match' : 'none'
  }
}

/**
 * How many steps the detector takes: none while a zone limit sets them, and
 * one for a match other than `equals` and `changesTo`, which have no
 * further values to climb through.
 */
export function maxSteps(d: DetectorForm): number {
  if (isZoneLimited(d)) return 0
  if (d.type === 'match' && d.matchOp !== 'equals' && d.matchOp !== 'changesTo') return 1
  return MAX_STEPS
}

/**
 * The form with the detector changed. A change of what a step's limit is
 * drops the limits typed for the old one, keeping the first step's priority;
 * a detector that takes fewer steps keeps the first ones.
 */
export function withDetector(form: RuleForm, patch: Partial<DetectorForm>): RuleForm {
  const detector = { ...form.detector, ...patch }
  const kept =
    stepQuantity(detector) === stepQuantity(form.detector)
      ? form.steps
      : [emptyStep(form.steps[0]?.priority ?? '')]
  // Zones stand in for the steps without replacing them, so turning zones off brings them back.
  const max = maxSteps(detector)
  return { ...form, detector, steps: max === 0 ? kept : kept.slice(0, max) }
}

// ---- conversions ----

/** How a field of `quantity` converts for a signal measured by `measure`. */
function kindFor(quantity: 'value' | 'interval' | 'slope', measure: Measure): QuantityKind {
  if (quantity === 'value') return measure.kind
  // A ratio's unit is unit one, so its slope still converts from the per
  // minute its field is labelled in.
  if (quantity === 'slope') return 'slope'
  if (measure.kind === 'ratio') return 'ratio'
  return quantity
}

/**
 * The stored SI value behind a number field, kept while the field shows the
 * text it opened with. A converted value is shown rounded, so converting the
 * text back would move a stored value the user never touched: 50 m shown as
 * 0.027 nmi would come back as 50.004 m.
 */
export interface Exact {
  text: string
  value: number
  /** How the field converted when it opened; another unit makes the text another value. */
  conversion: string
}

/** The exact values of a form object's number fields, by field. */
export type Exacts<K extends string> = Partial<Record<K, Exact>>

function conversion(kind: QuantityKind, unit: DisplayUnit): string {
  return [kind, unit.symbol, String(unit.scale), String(unit.offset)].join('|')
}

/**
 * A stored value as its field shows it: rounded as the panel shows values
 * when it converts, else as stored. The exact value is kept only where the
 * text would not convert back to it.
 */
function shownNumber(
  value: number,
  kind: QuantityKind,
  unit: DisplayUnit
): { text: string; exact?: Exact } {
  const display = fromSI(kind, value, unit)
  const text = converts(kind, unit) ? formatNumber(display) : String(display)
  if (toSI(kind, Number(text), unit) === value) return { text }
  return { text, exact: { text, value, conversion: conversion(kind, unit) } }
}

/** The `exact` of a form object from its fields' exact values, left out when there are none. */
function exacts<K extends string>(entries: [K, Exact | undefined][]): { exact?: Exacts<K> } {
  const kept = entries.filter((entry): entry is [K, Exact] => entry[1] !== undefined)
  return kept.length === 0 ? {} : { exact: Object.fromEntries(kept) as Exacts<K> }
}

type Holder<K extends string> = Record<K, string> & { exact?: Exacts<K> }

/** `holder` without the exact values of the fields whose text the user has changed. */
function forget<K extends string, T extends Holder<K>>(holder: T & Holder<K>): T {
  const { exact } = holder
  if (exact === undefined) return holder
  const fields = Object.keys(exact) as K[]
  const kept = fields.filter((field) => exact[field]?.text === holder[field])
  if (kept.length === fields.length) return holder
  return { ...holder, exact: Object.fromEntries(kept.map((field) => [field, exact[field]])) }
}

/**
 * The form with the exact value of every field the user has edited
 * forgotten, so typing the shown text back stores what it converts to. Run
 * on every change: a field edited and typed back to its text is still edited.
 */
export function forgetEdited(form: RuleForm): RuleForm {
  const d = form.detector
  const event = (e: EventForm): EventForm => ({ ...e, value: forget(e.value) })
  return {
    ...form,
    steps: form.steps.map((step) => forget({ ...step, value: forget(step.value) })),
    detector: forget({
      ...d,
      whileValue: forget(d.whileValue),
      resetOn: event(d.resetOn),
      event: event(d.event)
    }),
    gates: form.gates.map((gate) => ({ ...gate, limit: forget(gate.limit) }))
  }
}

/** A number as typed, a decimal comma accepted; undefined while empty or not a number. */
export function parsedNumber(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const value = Number(trimmed.replace(',', '.'))
  return Number.isFinite(value) ? value : undefined
}

export function durationFrom(seconds: number | undefined): DurationField {
  if (seconds === undefined) return noDuration()
  const whole = (u: DurationUnit) =>
    seconds >= DURATION_FACTORS[u] && seconds % DURATION_FACTORS[u] === 0
  const unit: DurationUnit = (['h', 'min'] as const).find(whole) ?? 's'
  return { amount: String(seconds / DURATION_FACTORS[unit]), unit }
}

/**
 * How a stored signal's numbers show; undefined while its unit is not
 * settled (`measureSettled`), as in a stored rule that does not validate
 * missing a path. Its numbers are then left to type again once a path is
 * picked: shown in SI, they would be read back in that path's display unit.
 */
function storedMeasure(signal: SignalForm, units: UnitLookup): Measure | undefined {
  const shape = signalShape(signal)
  return measureSettled(shape, units) ? signalMeasure(shape, units) : undefined
}

/**
 * An error on the form's field. One `withheld` marks its field invalid but keeps
 * its text off the page until Save: a commit that empties a number must not move
 * the controls below the field between a click's press and its release.
 */
export interface FormError extends FieldError {
  withheld?: true
}

const shown = ({ path, message }: FormError): FieldError => ({ path, message })

/** `errors` with each one's text shown, as every Save shows it. */
export function revealed(errors: readonly FormError[]): FieldError[] {
  return errors.map(shown)
}

/** The error on a hysteresis left empty for want of a unit: not "is required", as it may stay empty. */
export const RETYPE_IN_UNIT = 'must be typed again in the unit of the chosen path'

/** How a stored signal's numbers read, and where each number left empty is noted. */
interface StoredNumbers {
  measure: Measure | undefined
  emptied: FieldError[]
}

/**
 * A stored number of `quantity` at pointer `at` as its field shows it; empty
 * while the measure is unknown, noted so the form names it on opening.
 */
function storedNumber(
  value: number,
  quantity: 'value' | 'interval' | 'slope',
  stored: StoredNumbers,
  at: string,
  optional = false
): { text: string; exact?: Exact } {
  const { measure } = stored
  if (measure === undefined) {
    stored.emptied.push({ path: at, message: optional ? RETYPE_IN_UNIT : 'is required' })
    return { text: '' }
  }
  return shownNumber(value, kindFor(quantity, measure), measure.unit)
}

function valueFrom(
  value: number | string | boolean | undefined,
  stored: StoredNumbers,
  at: string
): ValueField {
  if (typeof value === 'number') {
    const { text, exact } = storedNumber(value, 'value', stored, at)
    return { type: 'number', text, ...exacts([['text', exact]]) }
  }
  if (typeof value === 'boolean') return { type: value ? 'true' : 'false', text: '' }
  return { type: value === undefined ? 'number' : 'text', text: value ?? '' }
}

type Accumulator = Extract<Detector, { type: 'accumulator' }>

const SIDES = every<Extract<Detector, { type: 'sustained' }>['direction']>({
  above: true,
  below: true
})
const TRENDS = every<Extract<Detector, { type: 'slope' }>['direction']>({
  rising: true,
  falling: true
})
const MATCH_OPS = every<MatchOp>({
  equals: true,
  notEquals: true,
  changesTo: true,
  decreases: true,
  timedOut: true
})
const MEASURES = every<Accumulator['measure']>({ time: true, integral: true })
const WHILE_OPS = every<NonNullable<Accumulator['while']>['op']>({
  above: true,
  below: true,
  equals: true,
  notEquals: true
})
const EVENT_OPS = every<EventOp>({ changes: true, changesTo: true, decreases: true })

/**
 * A stored choice as its field shows it: unchosen unless it is one the field
 * offers, so the form asks for it rather than pick for the user or send on
 * what the server refused.
 */
function choiceFrom<T extends string>(value: unknown, offered: readonly T[]): T | '' {
  return offered.find((choice) => choice === value) ?? ''
}

function eventFrom(event: Event, stored: StoredNumbers, at: string): EventForm {
  if (!isRecord(event)) return { op: '', value: noValue() }
  return {
    op: choiceFrom(event.op, EVENT_OPS),
    value: valueFrom(event.value, stored, `${at}/value`)
  }
}

function limitFrom(limit: Limit, stored: StoredNumbers, at: string): LimitForm {
  if (!isRecord(limit)) return noLimit()
  if (limit.kind === 'zone') {
    return {
      kind: 'zone',
      value: '',
      level: choiceFrom(limit.level, ZONE_LEVELS),
      path: limit.path ?? ''
    }
  }
  const { text, exact } = storedNumber(limit.value, 'value', stored, `${at}/value`)
  return { ...noLimit(), value: text, ...exacts([['value', exact]]) }
}

function signalFrom(signal: Signal): SignalForm {
  if (!isRecord(signal)) return emptySignal()
  // An input of a rule that does not validate may be anything, its path and source too.
  const slot = (input: unknown): SlotForm => {
    if (!isRecord(input)) return noSlot()
    const text = (value: unknown) => (typeof value === 'string' ? value : '')
    return { path: text(input.path), source: text(input.source) }
  }
  if (!('combinator' in signal)) return { ...emptySignal(), slots: [slot(signal)] }
  const inputs: unknown = signal.inputs
  const stored: unknown[] | undefined = Array.isArray(inputs) ? inputs : undefined
  return {
    mode: 'combine',
    combinator: signal.combinator,
    angular: signal.angular === true,
    slots: stored?.map(slot) ?? fitSlots([], slotBounds(signal.combinator))
  }
}

/** A rule's gates; a lone gate stored without its list is read as the list of it. */
function gateList(gates: Rule['gates']): Gate[] {
  const stored: unknown = gates
  if (Array.isArray(stored)) return stored as Gate[]
  // Anything else stored there was meant as a gate: dropping it would save the rule without one.
  return stored === undefined ? [] : [stored as Gate]
}

function gateFrom(gate: Gate, at: string, units: UnitLookup, emptied: FieldError[]): GateForm {
  if (!isRecord(gate)) return { ...emptyGate(), direction: '' }
  const signal = signalFrom(gate.signal)
  const stored = { measure: storedMeasure(signal, units), emptied }
  return {
    signal,
    direction: choiceFrom(gate.direction, SIDES),
    limit: limitFrom(gate.limit, stored, `${at}/limit`),
    duration: durationFrom(gate.duration)
  }
}

/** A stored rule's body as the form opens it, and the numbers left empty for want of a unit. */
export interface OpenedBody {
  form: RuleForm
  /** Each number left to type again, as an error at its field. */
  emptied: FieldError[]
}

/**
 * A stored rule that does not validate, as the form shows it to be fixed:
 * as `fromRule` shows it while its body has the shape of a rule, else with
 * what can be read of it, so the user can fill in the rest.
 */
export function fromBody(body: unknown, units: UnitLookup): OpenedBody {
  const text = (key: string) => (isRecord(body) && typeof body[key] === 'string' ? body[key] : '')
  const texts = { name: text('name'), slug: text('slug'), message: text('message') }
  // A missing detector reads as one not yet chosen, so the rest of the body still shows.
  const readable =
    isRecord(body) && !isRecord(body.detector) ? { ...body, detector: { type: '' } } : body
  try {
    const emptied: FieldError[] = []
    const form = readRule(readable as Rule, units, emptied)
    // A detector the form has no fields for is shown unchosen, to be chosen again.
    const type = Object.hasOwn(DETECTOR_TYPES, form.detector.type) ? form.detector.type : ''
    return {
      form: {
        ...form,
        ...texts,
        condition: text('condition'),
        detector: { ...form.detector, type }
      },
      emptied
    }
  } catch {
    // Damage the readers do not check, such as a detector's `while` that is null.
    return {
      form: {
        ...emptyForm(),
        ...texts,
        slugFollowsName: false,
        nameFollows: false,
        messageFollows: false
      },
      emptied: []
    }
  }
}

/**
 * A stored rule as the form shows it, numbers in the display units of its
 * paths. It also reads the body of a rule that does not validate
 * (`fromBody`): a missing or malformed signal, input, limit, event, step list
 * or gate reads as that part's empty form, left to fill in, and so does a
 * number in the unit of a signal without a path (`storedMeasure`) and a
 * missing or unknown choice, such as a direction (`choiceFrom`). Other
 * fields are taken as stored, and `fromBody` catches what this cannot read.
 */
export function fromRule(rule: Rule, units: UnitLookup): RuleForm {
  return readRule(rule, units, [])
}

/** `fromRule`, noting in `emptied` each number it leaves empty for want of a unit. */
function readRule(rule: Rule, units: UnitLookup, emptied: FieldError[]): RuleForm {
  const form = emptyForm()
  const signal = signalFrom(rule.signal)
  const stored = { measure: storedMeasure(signal, units), emptied }
  const d = form.detector
  const detector = rule.detector
  d.type = detector.type
  const hysteresisFrom = (value: number | undefined) => {
    if (value === undefined) return
    const { text, exact } = storedNumber(value, 'interval', stored, '/detector/hysteresis', true)
    d.hysteresis = text
    Object.assign(d, exacts([['hysteresis', exact]]))
  }
  switch (detector.type) {
    case 'match':
      d.matchOp = choiceFrom(detector.op, MATCH_OPS)
      d.duration = durationFrom(detector.duration)
      break
    case 'sustained':
      d.direction = choiceFrom(detector.direction, SIDES)
      if (detector.limit !== undefined)
        d.limit = limitFrom(detector.limit, stored, '/detector/limit')
      d.duration = durationFrom(detector.duration)
      hysteresisFrom(detector.hysteresis)
      break
    case 'outside':
      d.duration = durationFrom(detector.duration)
      hysteresisFrom(detector.hysteresis)
      break
    case 'slope':
      d.trend = choiceFrom(detector.direction, TRENDS)
      d.window = durationFrom(detector.window)
      break
    case 'projection':
      d.trend = choiceFrom(detector.direction, TRENDS)
      if (detector.limit !== undefined)
        d.limit = limitFrom(detector.limit, stored, '/detector/limit')
      d.window = durationFrom(detector.window)
      d.horizon = durationFrom(detector.horizon)
      break
    case 'accumulator':
      d.measure = choiceFrom(detector.measure, MEASURES)
      if (detector.while !== undefined) {
        d.useWhile = true
        d.whileOp = choiceFrom(detector.while.op, WHILE_OPS)
        d.whileValue = valueFrom(detector.while.value, stored, '/detector/while/value')
      }
      if (detector.resetOn !== undefined) {
        d.useResetOn = true
        d.resetOn = eventFrom(detector.resetOn, stored, '/detector/resetOn')
      }
      break
    case 'count':
      d.event = eventFrom(detector.event, stored, '/detector/event')
      d.window = durationFrom(detector.window)
      break
    case 'absence':
      d.event = eventFrom(detector.event, stored, '/detector/event')
      break
  }
  const quantity = stepQuantity(d)
  const stepFrom = (step: Step, index: number): StepForm => {
    if (!isRecord(step)) return emptyStep()
    const at = stepPointer(index)
    const numberFrom = (value: number, measured: 'value' | 'slope' | 'interval', field: string) =>
      storedNumber(value, measured, stored, `${at}/${field}`)
    const form = emptyStep(choiceFrom(step.priority, PRIORITY_LEVELS))
    if ('value' in step) form.value = valueFrom(step.value, stored, `${at}/value`)
    if ('within' in step) form.duration = durationFrom(step.within)
    if ('low' in step) {
      const low = numberFrom(step.low, 'value', 'low')
      const high = numberFrom(step.high, 'value', 'high')
      form.low = low.text
      form.high = high.text
      Object.assign(
        form,
        exacts([
          ['low', low.exact],
          ['high', high.exact]
        ])
      )
    }
    if (!('limit' in step)) return form
    const limit = (shown: { text: string; exact?: Exact }) => {
      form.limit = shown.text
      Object.assign(form, exacts([['limit', shown.exact]]))
    }
    switch (quantity) {
      case 'value':
        limit(numberFrom(step.limit, 'value', 'limit'))
        break
      case 'slope':
        limit(numberFrom(step.limit, 'slope', 'limit'))
        break
      case 'integral':
        limit(numberFrom(step.limit, 'interval', 'limit'))
        break
      case 'time':
        form.duration = durationFrom(step.limit)
        break
      default:
        form.limit = String(step.limit)
    }
    return form
  }
  const steps: Step[] = Array.isArray(detector.steps) ? detector.steps : []
  return {
    ...form,
    name: rule.name,
    slug: rule.slug,
    slugFollowsName: false,
    condition: rule.condition ?? '',
    message: rule.message,
    messageFollows: false,
    nameFollows: false,
    // A zone limit's steps are its zones; an empty row stands ready for typed ones.
    steps: steps.length === 0 ? [emptyStep()] : steps.map(stepFrom),
    latching: rule.latching === true,
    signal,
    detector: d,
    ...(rule.template === undefined ? {} : { template: rule.template }),
    gates: gateList(rule.gates).map((g, i) => gateFrom(g, `/gates/${String(i)}`, units, emptied))
  }
}

export type ToRuleResult = { ok: true; rule: Rule } | { ok: false; errors: FieldError[] }

/** Collects the local errors of one conversion, each at its JSON pointer into the rule. */
class Reader {
  readonly errors: FieldError[] = []

  fail(path: string, message: string): void {
    this.errors.push({ path, message })
  }

  text(value: string, path: string): string {
    if (value.trim() === '') this.fail(path, 'is required')
    return value
  }

  /** A number typed in `unit`, in SI; undefined when empty (an error unless optional) or bad. */
  number(
    text: string,
    path: string,
    kind: QuantityKind,
    unit: DisplayUnit,
    { optional = false, exact }: { optional?: boolean; exact?: Exact } = {}
  ): number | undefined {
    if (text.trim() === '') {
      if (!optional) this.fail(path, 'is required')
      return undefined
    }
    if (exact?.text === text && exact.conversion === conversion(kind, unit)) return exact.value
    const value = parsedNumber(text)
    if (value === undefined) {
      this.fail(path, 'must be a number')
      return undefined
    }
    return toSI(kind, value, unit)
  }

  duration(field: DurationField, path: string, optional = false): number | undefined {
    const value = this.number(field.amount, path, 'ratio', UNIT_ONE, { optional })
    // Minutes and hours of a decimal amount leave float noise in the seconds.
    return value === undefined
      ? undefined
      : Number((value * DURATION_FACTORS[field.unit]).toPrecision(12))
  }

  value(field: ValueField, path: string, measure: Measure): number | string | boolean | undefined {
    switch (field.type) {
      case 'number': {
        const exact = field.exact?.text
        return this.number(field.text, path, measure.kind, measure.unit, { exact })
      }
      case 'text':
        return field.text
      case 'true':
        return true
      case 'false':
        return false
    }
  }

  choice<T extends string>(value: T | '', path: string): T | undefined {
    if (value !== '') return value
    this.fail(path, 'is required')
    return undefined
  }
}

/** Keys whose value is undefined are left out, as the stored JSON has them. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

function readSignal(
  form: SignalForm,
  at: string,
  units: UnitLookup,
  read: Reader
): Signal | undefined {
  const input = (slot: SlotForm, path: string): PathInput =>
    defined({
      path: read.text(slot.path, path),
      source: slot.source === '' ? undefined : slot.source
    })
  if (form.mode === 'single') return input(form.slots[0] ?? noSlot(), `${at}/path`)
  const unitErrors = slotUnitErrors(form, units)
  const inputs = form.slots.map((slot, i) => {
    const path = `${at}/inputs/${String(i)}/path`
    const mismatch = unitErrors[i]
    if (mismatch !== undefined && slot.path.trim() !== '') read.fail(path, mismatch)
    return input(slot, path)
  })
  return defined({
    combinator: form.combinator,
    inputs,
    angular: form.angular && ANGULAR_KINDS.has(form.combinator) ? true : undefined
  })
}

function readLimit(form: LimitForm, at: string, measure: Measure, read: Reader): Limit | undefined {
  if (form.kind === 'zone') {
    return defined({
      kind: 'zone',
      level: read.choice(form.level, `${at}/level`),
      path: form.path === '' ? undefined : form.path
    }) as Limit
  }
  const value = read.number(form.value, `${at}/value`, measure.kind, measure.unit, {
    exact: form.exact?.value
  })
  return value === undefined ? undefined : { kind: 'fixed', value }
}

function readEvent(form: EventForm, at: string, measure: Measure, read: Reader): Event {
  return defined({
    op: read.choice(form.op, `${at}/op`),
    value: form.op === 'changesTo' ? read.value(form.value, `${at}/value`, measure) : undefined
  }) as Event
}

export type StepLimitField = 'limit' | 'low' | 'high' | 'within' | 'value'

/** The step fields its limit is stored in, in the order shown; none for a step that is its priority alone. */
export function stepLimitFields(quantity: StepQuantity | undefined): readonly StepLimitField[] {
  switch (quantity) {
    case undefined:
    case 'none':
      return []
    case 'within':
      return ['within']
    case 'match':
      return ['value']
    case 'range':
      return ['low', 'high']
    default:
      return ['limit']
  }
}

/** Where step `index` is in the rule. */
export function stepPointer(index: number): string {
  return `/detector/steps/${String(index)}`
}

function readSteps(form: RuleForm, measure: Measure, read: Reader): Step[] {
  const quantity = stepQuantity(form.detector)
  const field = stepLimitFields(quantity).at(0) ?? ''
  return form.steps.map((step, i) => {
    const at = stepPointer(i)
    const limitAt = `${at}/${field}`
    const number = (kind: QuantityKind) =>
      read.number(step.limit, limitAt, kind, measure.unit, { exact: step.exact?.limit })
    const value = (text: string, side: 'low' | 'high') =>
      read.number(text, `${at}/${side}`, measure.kind, measure.unit, { exact: step.exact?.[side] })
    const limit = (() => {
      switch (quantity) {
        case 'value':
          return { limit: number(measure.kind) }
        case 'range':
          return { low: value(step.low, 'low'), high: value(step.high, 'high') }
        case 'slope':
          return { limit: number(kindFor('slope', measure)) }
        case 'integral':
          return { limit: number(kindFor('interval', measure)) }
        case 'count':
          return { limit: number('ratio') }
        case 'time':
          return { limit: read.duration(step.duration, limitAt) }
        case 'within':
          return { within: read.duration(step.duration, limitAt) }
        case 'match':
          return { value: read.value(step.value, limitAt, measure) }
        default:
          return {}
      }
    })()
    return defined({ ...limit, priority: read.choice(step.priority, `${at}/priority`) }) as Step
  })
}

function readDetector(form: RuleForm, measure: Measure, read: Reader): Detector | undefined {
  const d = form.detector
  const at = '/detector'
  const hysteresis = (text: string) =>
    read.number(text, `${at}/hysteresis`, kindFor('interval', measure), measure.unit, {
      optional: true,
      exact: d.exact?.hysteresis
    })
  const steps = () => readSteps(form, measure, read)
  // A zone limit takes the place of the steps.
  const valueLimit = () =>
    d.limit.kind === 'zone'
      ? { limit: readLimit(d.limit, `${at}/limit`, measure, read) }
      : { steps: steps() }
  switch (d.type) {
    case '':
      read.fail(`${at}/type`, 'is required')
      return undefined
    case 'match':
      return defined({
        type: 'match',
        op: read.choice(d.matchOp, `${at}/op`),
        steps: steps(),
        duration: matchTakesDuration(d.matchOp)
          ? read.duration(d.duration, `${at}/duration`, d.matchOp !== 'timedOut')
          : undefined
      }) as Detector
    case 'sustained':
      return defined({
        type: 'sustained',
        direction: read.choice(d.direction, `${at}/direction`),
        ...valueLimit(),
        duration: read.duration(d.duration, `${at}/duration`, true),
        hysteresis: hysteresis(d.hysteresis)
      }) as Detector
    case 'outside':
      return defined({
        type: 'outside',
        steps: steps(),
        duration: read.duration(d.duration, `${at}/duration`, true),
        hysteresis: hysteresis(d.hysteresis)
      }) as Detector
    case 'slope':
      return defined({
        type: 'slope',
        direction: read.choice(d.trend, `${at}/direction`),
        window: read.duration(d.window, `${at}/window`),
        steps: steps()
      }) as Detector
    case 'projection':
      return defined({
        type: 'projection',
        direction: read.choice(d.trend, `${at}/direction`),
        ...valueLimit(),
        window: read.duration(d.window, `${at}/window`),
        horizon: read.duration(d.horizon, `${at}/horizon`)
      }) as Detector
    case 'accumulator':
      return defined({
        type: 'accumulator',
        measure: read.choice(d.measure, `${at}/measure`),
        while: d.useWhile
          ? {
              op: read.choice(d.whileOp, `${at}/while/op`),
              value: read.value(d.whileValue, `${at}/while/value`, measure)
            }
          : undefined,
        resetOn: d.useResetOn ? readEvent(d.resetOn, `${at}/resetOn`, measure, read) : undefined,
        steps: steps()
      }) as Detector
    case 'count':
      return defined({
        type: 'count',
        event: readEvent(d.event, `${at}/event`, measure, read),
        window: read.duration(d.window, `${at}/window`),
        steps: steps()
      }) as Detector
    case 'absence':
      return defined({
        type: 'absence',
        event: readEvent(d.event, `${at}/event`, measure, read),
        steps: steps()
      }) as Detector
  }
}

function readGate(form: GateForm, at: string, units: UnitLookup, read: Reader): Gate {
  const measure = signalMeasure(signalShape(form.signal), units)
  return defined({
    signal: readSignal(form.signal, `${at}/signal`, units, read),
    direction: read.choice(form.direction, `${at}/direction`),
    limit: readLimit(form.limit, `${at}/limit`, measure, read),
    duration: read.duration(form.duration, `${at}/duration`, true)
  }) as Gate
}

// The signal document of the input paths chosen so far, for the alert path's parent.
function chosenSignal(signal: SignalForm): unknown {
  const paths = signal.slots.map((s) => s.path).filter((p) => p !== '')
  if (paths.length === 0) return undefined
  return signal.mode === 'single'
    ? { path: paths[0] }
    : { combinator: signal.combinator, inputs: paths.map((path) => ({ path })) }
}

/**
 * The default condition name of the input and detector chosen so far:
 * undefined until the choices that name the condition are made, and for a
 * combined signal, which has none.
 */
export function defaultFormCondition(form: RuleForm): string | undefined {
  const d = form.detector
  const direction = d.type === 'sustained' ? d.direction : d.trend
  return defaultCondition(chosenSignal(form.signal), { type: d.type, direction, op: d.matchOp })
}

/** The alert path before the condition name, from `alerts.` to the dot before it. */
export function formAlertPrefix(form: RuleForm): string {
  return ['alerts', ...(alertParent(chosenSignal(form.signal)) ?? []), ''].join('.')
}

/**
 * The rule the form describes, in SI units, or the fields that are missing or
 * not numbers. Everything else, such as ranges and combinations, the server
 * checks when the rule is saved. An empty message is refused here; Save goes
 * through `toSavedRule` (message.ts), which sends the written one instead.
 */
export function toRule(form: RuleForm, units: UnitLookup): ToRuleResult {
  const read = new Reader()
  const measure = signalMeasure(signalShape(form.signal), units)
  const name = read.text(form.name, '/name')
  const slug = read.text(form.slug, '/slug')
  const message = read.text(form.message, '/message')
  const signal = readSignal(form.signal, '/signal', units, read)
  const detector = readDetector(form, measure, read)
  const gates = form.gates.map((g, i) => readGate(g, `/gates/${String(i)}`, units, read))
  if (read.errors.length > 0 || signal === undefined || detector === undefined) {
    return { ok: false, errors: read.errors }
  }
  const rule = defined({
    name,
    slug,
    // Left out, the name follows the default, or the server says why there is none.
    condition: form.condition === '' ? undefined : form.condition,
    message,
    latching: form.latching && canLatch(form.detector) ? true : undefined,
    signal,
    detector,
    gates: gates.length > 0 ? gates : undefined,
    template: form.template
  }) as Rule
  return { ok: true, rule }
}

// ---- a path shown in another unit ----

/** A number shown in its signal's display unit, at its pointer, and how to empty it. */
interface UnitNumber {
  at: string
  optional: boolean
  text: string
  clear: (form: RuleForm) => RuleForm
}

/** `holder` with `field` empty and its exact value forgotten. */
function withEmpty<K extends string, T extends Holder<K>>(holder: T, field: K): T {
  const entries = Object.entries(holder.exact ?? {}) as [K, Exact | undefined][]
  const { exact: _exact, ...rest } = holder
  return { ...rest, [field]: '', ...exacts(entries.filter(([key]) => key !== field)) } as T
}

/**
 * What a signal's numbers are typed in. A ratio is a unit of its own: it shares SI with a
 * signal of no known unit, yet a number typed for one means nothing for the other.
 */
function unitKey(signal: SignalForm, units: UnitLookup): string {
  const { kind, unit } = signalMeasure(signalShape(signal), units)
  if (kind === 'ratio') return 'ratio'
  return [unit.symbol, String(unit.scale), String(unit.offset)].join('|')
}

/** The number of gate `index` typed in its signal's display unit: its limit. */
function gateNumbers(form: RuleForm, index: number): UnitNumber[] {
  const gate = form.gates[index]
  return [
    {
      at: `/gates/${String(index)}/limit/value`,
      optional: false,
      text: gate.limit.value,
      clear: (f: RuleForm) => ({
        ...f,
        gates: f.gates.map((g, i) =>
          i === index ? { ...g, limit: withEmpty(g.limit, 'value') } : g
        )
      })
    }
  ]
}

/**
 * Every number of the rule's own signal typed in its display unit.
 * Durations, counts, text and true/false values have no unit and are left out.
 */
function signalNumbers(form: RuleForm): UnitNumber[] {
  const d = form.detector
  const detector = (f: RuleForm, change: (d: DetectorForm) => DetectorForm): RuleForm => ({
    ...f,
    detector: change(f.detector)
  })
  type ValueAt = [
    string,
    (d: DetectorForm) => ValueField,
    (d: DetectorForm, v: ValueField) => DetectorForm
  ]
  const values: ValueAt[] = [
    ['/detector/while/value', (dd) => dd.whileValue, (dd, v) => ({ ...dd, whileValue: v })],
    [
      '/detector/resetOn/value',
      (dd) => dd.resetOn.value,
      (dd, v) => ({ ...dd, resetOn: { ...dd.resetOn, value: v } })
    ],
    [
      '/detector/event/value',
      (dd) => dd.event.value,
      (dd, v) => ({ ...dd, event: { ...dd.event, value: v } })
    ]
  ]
  const quantity = stepQuantity(d)
  const limitInUnit = quantity === 'value' || quantity === 'slope' || quantity === 'integral'
  const steps = form.steps.flatMap((step, index): UnitNumber[] => {
    const at = stepPointer(index)
    const patch = (f: RuleForm, change: (s: StepForm) => StepForm): RuleForm => ({
      ...f,
      steps: f.steps.map((s, i) => (i === index ? change(s) : s))
    })
    const field = (name: 'limit' | 'low' | 'high'): UnitNumber => ({
      at: `${at}/${name}`,
      optional: false,
      text: step[name],
      clear: (f: RuleForm) => patch(f, (st) => withEmpty(st, name))
    })
    return [
      ...(limitInUnit ? [field('limit')] : []),
      field('low'),
      field('high'),
      ...(step.value.type === 'number'
        ? [
            {
              at: `${at}/value`,
              optional: false,
              text: step.value.text,
              clear: (f: RuleForm) =>
                patch(f, (st) => ({ ...st, value: withEmpty(st.value, 'text') }))
            }
          ]
        : [])
    ]
  })
  return [
    {
      at: '/detector/limit/value',
      optional: false,
      text: d.limit.value,
      clear: (f: RuleForm) => detector(f, (dd) => ({ ...dd, limit: withEmpty(dd.limit, 'value') }))
    },
    {
      at: '/detector/hysteresis',
      optional: true,
      text: d.hysteresis,
      clear: (f: RuleForm) => detector(f, (dd) => withEmpty(dd, 'hysteresis'))
    },
    ...values
      .filter(([, get]) => get(d).type === 'number')
      .map(([at, get, set]) => ({
        at,
        optional: false,
        text: get(d).text,
        clear: (f: RuleForm) => detector(f, (dd) => set(dd, withEmpty(get(dd), 'text')))
      })),
    ...steps
  ]
}

/**
 * `form` with every number typed in a display unit emptied where its signal
 * is in another unit than in `settled`, the form as last settled: shown as
 * typed, the number would be read in the new unit, 2.57 m/s saved as 2.57 kn.
 * Each emptied number is returned as an error at its field, its text withheld;
 * with none, `form` itself is returned.
 */
export function withNumbersInUnit(
  settled: RuleForm,
  form: RuleForm,
  units: UnitLookup
): { form: RuleForm; emptied: FormError[] } {
  let next = form
  const emptied: FormError[] = []
  const empty = (numbers: (f: RuleForm) => UnitNumber[]) => {
    for (const n of numbers(next)) {
      if (n.text === '') continue
      next = n.clear(next)
      emptied.push({
        path: n.at,
        message: n.optional ? RETYPE_IN_UNIT : 'is required',
        withheld: true
      })
    }
  }
  const moved = (before: SignalForm, after: SignalForm) =>
    unitKey(before, units) !== unitKey(after, units)
  if (moved(settled.signal, form.signal)) empty(signalNumbers)
  // Gates added or removed since are not the ones settled at the same index.
  if (settled.gates.length === form.gates.length) {
    form.gates.forEach((gate, i) => {
      if (moved(settled.gates[i].signal, gate.signal)) empty((f) => gateNumbers(f, i))
    })
  }
  return { form: next, emptied }
}

/**
 * `errors` with those on the numbers a change of unit emptied replaced by
 * theirs; a field already showing an error's text keeps showing one.
 */
export function withUnitErrors(
  errors: readonly FormError[],
  emptied: readonly FormError[]
): FormError[] {
  const touched = new Set(emptied.map((e) => e.path))
  const showing = new Set(errors.filter((e) => e.withheld !== true).map((e) => e.path))
  return [
    ...errors.filter((e) => !touched.has(e.path)),
    ...emptied.map((e) => (showing.has(e.path) ? shown(e) : e))
  ]
}

/**
 * The notes on hysteresis fields emptied for want of their unit and still
 * empty: the only sign a hysteresis was emptied, which a Save keeps.
 */
export function standingRetypes(form: RuleForm, errors: readonly FormError[]): FormError[] {
  const empty = new Set(
    signalNumbers(form)
      .filter((n) => n.text === '')
      .map((n) => n.at)
  )
  return errors.filter((e) => e.message === RETYPE_IN_UNIT && empty.has(e.path))
}

/**
 * Whether Save stops for an emptied hysteresis: one whose note no footer
 * has named yet, at a refused Save or on opening (`named`). A hysteresis emptied
 * as focus leaves a path search for Save would otherwise be dropped unseen.
 */
export function marginUnnamed(retypes: readonly FieldError[], named: ReadonlySet<string>): boolean {
  return retypes.some((e) => !named.has(e.path))
}

/** `named` with the notes on fields a change of unit emptied again forgotten. */
export function forgetNamed(
  named: ReadonlySet<string>,
  emptied: readonly FieldError[]
): Set<string> {
  const again = new Set(emptied.map((e) => e.path))
  return new Set([...named].filter((p) => !again.has(p)))
}

/** A condition's own pointer prefix, its index read whole: `/gates/10` is not `/gates/1`. */
const GATE_POINTER = /^\/gates\/(\d+)(?=\/|$)/

/**
 * The editor's errors once condition `removed` is gone: its own dropped, and
 * those of the conditions after it moved down by one to the index each now
 * holds.
 */
export function withoutGate<E extends FieldError>(errors: readonly E[], removed: number): E[] {
  const moved = (pointer: string): string[] => {
    const match = GATE_POINTER.exec(pointer)
    if (match === null) return [pointer]
    const index = Number(match[1])
    if (index === removed) return []
    if (index < removed) return [pointer]
    return [`/gates/${String(index - 1)}${pointer.slice(match[0].length)}`]
  }
  return errors.flatMap((e) => moved(e.path).map((path) => ({ ...e, path })))
}
