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
import { alertParent, defaultCondition } from '../../alerts/paths'
import { isRecord, type FieldError } from '../api'
import {
  POSITION_KINDS,
  signalMeasure,
  type Measure,
  type SignalShape,
  type UnitLookup
} from '../signalUnits'
import { fromSI, toSI, type DisplayUnit, type QuantityKind } from '../units'

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
export const PRIORITY_LEVELS = [
  'emergency',
  'alarm',
  'warning',
  'caution'
] as const satisfies readonly Priority[]
export const ZONE_LEVEL_NAMES = [
  'alert',
  'warn',
  'alarm',
  'emergency'
] as const satisfies readonly ZoneLevel[]
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

export type DetectorType = Exclude<Detector['type'], 'outside'>
const DETECTOR_TYPES: Readonly<Record<DetectorType, true>> = {
  sustained: true,
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
export const DURATION_FACTORS: Readonly<Record<DurationUnit, number>> = { s: 1, min: 60, h: 3600 }

export interface DurationField {
  amount: string
  unit: DurationUnit
}

/** A match, state or event value: a number in the display unit, text, or a boolean. */
export type ValueType = 'number' | 'text' | 'true' | 'false'
export interface ValueField {
  type: ValueType
  text: string
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
  level: ZoneLevel
  /** A zone limit's path; empty for the signal's own. */
  path: string
}

export interface EventForm {
  op: EventOp
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
  whileOp: StateOp
  whileValue: ValueField
  useResetOn: boolean
  resetOn: EventForm
  event: EventForm
  duration: DurationField
  window: DurationField
  horizon: DurationField
  hysteresis: string
  clearDuration: DurationField
}

export interface GateForm {
  signal: SignalForm
  direction: 'above' | 'below'
  limit: LimitForm
  duration: DurationField
  hysteresis: string
  clearDuration: DurationField
}

/**
 * One step of the climb: a priority and the limit it is reached at. Which
 * field holds the limit depends on the detector (`stepQuantity`).
 */
export interface StepForm {
  priority: Priority | ''
  /** A number in the unit its quantity is shown in. */
  limit: string
  /** An accumulated time, or an absence's window. */
  duration: DurationField
  /** A match's value. */
  value: ValueField
}

/** What a step's limit is, which decides how it is entered and stored. */
export type StepQuantity =
  | 'value'
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
  shown: ShownValues
  /** The template the rule was made from, which the form does not show and an edit keeps. */
  template?: TemplateRecord
}

const UNIT_ONE: DisplayUnit = { symbol: '', scale: 1, offset: 0, si: true }

const noDuration = (): DurationField => ({ amount: '', unit: 's' })
const noValue = (): ValueField => ({ type: 'number', text: '' })
const noLimit = (): LimitForm => ({ kind: 'fixed', value: '', level: 'warn', path: '' })
const noSlot = (): SlotForm => ({ path: '', source: '' })

export function emptyStep(priority: Priority | '' = ''): StepForm {
  return { priority, limit: '', duration: noDuration(), value: noValue() }
}

export function emptySignal(): SignalForm {
  return { mode: 'single', combinator: 'difference', angular: false, slots: [noSlot()] }
}

export function emptyGate(): GateForm {
  return {
    signal: emptySignal(),
    direction: 'above',
    limit: noLimit(),
    duration: noDuration(),
    hysteresis: '',
    clearDuration: noDuration()
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
      resetOn: { op: 'changes', value: noValue() },
      event: { op: 'changes', value: noValue() },
      duration: noDuration(),
      window: noDuration(),
      horizon: noDuration(),
      hysteresis: '',
      clearDuration: noDuration()
    },
    gates: [],
    shown: {}
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
  return signal.mode === 'single' && (signal.slots[0]?.path ?? '').split('.').includes('*')
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
  return d.type === 'sustained' || (d.type === 'match' && matchTakesDuration(d.matchOp))
}

/** What the detector's step limits are; undefined until the detector is chosen. */
export function stepQuantity(d: DetectorForm): StepQuantity | undefined {
  switch (d.type) {
    case '':
      return undefined
    case 'sustained':
    case 'projection':
      return 'value'
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
 * The SI value each shown number came from, keyed by how it converts and the
 * text shown. The shown text is rounded, so converting it back would move a
 * stored value the user never touched: 0.1 rad shown in degrees would come
 * back as 0.100000000000031.
 */
export type ShownValues = Partial<Record<string, number>>

function shownKey(text: string, kind: QuantityKind, unit: DisplayUnit): string {
  return [kind, unit.symbol, String(unit.scale), String(unit.offset), text.trim()].join('|')
}

function shownNumber(
  value: number,
  kind: QuantityKind,
  unit: DisplayUnit,
  shown: ShownValues
): string {
  const text = String(fromSI(kind, value, unit))
  shown[shownKey(text, kind, unit)] = value
  return text
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

function valueFrom(
  value: number | string | boolean | undefined,
  measure: Measure,
  shown: ShownValues
): ValueField {
  if (typeof value === 'number') {
    return { type: 'number', text: shownNumber(value, measure.kind, measure.unit, shown) }
  }
  if (typeof value === 'boolean') return { type: value ? 'true' : 'false', text: '' }
  return { type: value === undefined ? 'number' : 'text', text: value ?? '' }
}

function eventFrom(event: Event, measure: Measure, shown: ShownValues): EventForm {
  return { op: event.op, value: valueFrom(event.value, measure, shown) }
}

function limitFrom(limit: Limit, measure: Measure, shown: ShownValues): LimitForm {
  if (limit.kind === 'zone') {
    return { kind: 'zone', value: '', level: limit.level, path: limit.path ?? '' }
  }
  return { ...noLimit(), value: shownNumber(limit.value, measure.kind, measure.unit, shown) }
}

function signalFrom(signal: Signal): SignalForm {
  const slot = (input: PathInput): SlotForm => ({ path: input.path, source: input.source ?? '' })
  if (!('combinator' in signal)) return { ...emptySignal(), slots: [slot(signal)] }
  return {
    mode: 'combine',
    combinator: signal.combinator,
    angular: signal.angular === true,
    slots: signal.inputs.map(slot)
  }
}

function gateFrom(gate: Gate, units: UnitLookup, shown: ShownValues): GateForm {
  const signal = signalFrom(gate.signal)
  const measure = signalMeasure(signalShape(signal), units)
  return {
    signal,
    direction: gate.direction,
    limit: limitFrom(gate.limit, measure, shown),
    duration: durationFrom(gate.duration),
    hysteresis:
      gate.hysteresis === undefined
        ? ''
        : shownNumber(gate.hysteresis, kindFor('interval', measure), measure.unit, shown),
    clearDuration: durationFrom(gate.clearDuration)
  }
}

/**
 * A stored rule that does not validate, as the form shows it to be fixed:
 * as `fromRule` shows it while its body has the shape of a rule, else with
 * what can be read of it, so the user can fill in the rest.
 */
export function fromBody(body: unknown, units: UnitLookup): RuleForm {
  const text = (key: string) => (isRecord(body) && typeof body[key] === 'string' ? body[key] : '')
  const texts = { name: text('name'), slug: text('slug'), message: text('message') }
  try {
    const form = fromRule(body as Rule, units)
    // A detector the form has no fields for is shown unchosen, to be chosen again.
    const type = Object.hasOwn(DETECTOR_TYPES, form.detector.type) ? form.detector.type : ''
    return {
      ...form,
      ...texts,
      condition: text('condition'),
      detector: { ...form.detector, type }
    }
  } catch {
    return {
      ...emptyForm(),
      ...texts,
      slugFollowsName: false,
      nameFollows: false,
      messageFollows: false
    }
  }
}

/** A stored rule as the form shows it, numbers in the display units of its paths. */
export function fromRule(rule: Rule, units: UnitLookup): RuleForm {
  const form = emptyForm()
  const shown: ShownValues = {}
  const signal = signalFrom(rule.signal)
  const measure = signalMeasure(signalShape(signal), units)
  const d = form.detector
  const detector = rule.detector
  d.type = detector.type === 'outside' ? '' : detector.type
  const numberFrom = (value: number, quantity: 'slope' | 'interval') =>
    shownNumber(value, kindFor(quantity, measure), measure.unit, shown)
  switch (detector.type) {
    case 'match':
      d.matchOp = detector.op
      d.duration = durationFrom(detector.duration)
      break
    case 'sustained':
      d.direction = detector.direction
      if (detector.limit !== undefined) d.limit = limitFrom(detector.limit, measure, shown)
      d.duration = durationFrom(detector.duration)
      d.hysteresis =
        detector.hysteresis === undefined ? '' : numberFrom(detector.hysteresis, 'interval')
      d.clearDuration = durationFrom(detector.clearDuration)
      break
    case 'slope':
      d.trend = detector.direction
      d.window = durationFrom(detector.window)
      break
    case 'projection':
      d.trend = detector.direction
      if (detector.limit !== undefined) d.limit = limitFrom(detector.limit, measure, shown)
      d.window = durationFrom(detector.window)
      d.horizon = durationFrom(detector.horizon)
      break
    case 'accumulator':
      d.measure = detector.measure
      if (detector.while !== undefined) {
        d.useWhile = true
        d.whileOp = detector.while.op
        d.whileValue = valueFrom(detector.while.value, measure, shown)
      }
      if (detector.resetOn !== undefined) {
        d.useResetOn = true
        d.resetOn = eventFrom(detector.resetOn, measure, shown)
      }
      break
    case 'count':
      d.event = eventFrom(detector.event, measure, shown)
      d.window = durationFrom(detector.window)
      break
    case 'absence':
      d.event = eventFrom(detector.event, measure, shown)
      break
  }
  const quantity = stepQuantity(d)
  const stepFrom = (step: Step): StepForm => {
    const form = emptyStep(step.priority)
    if ('value' in step) form.value = valueFrom(step.value, measure, shown)
    if ('within' in step) form.duration = durationFrom(step.within)
    if (!('limit' in step)) return form
    switch (quantity) {
      case 'value':
        form.limit = shownNumber(step.limit, measure.kind, measure.unit, shown)
        break
      case 'slope':
        form.limit = numberFrom(step.limit, 'slope')
        break
      case 'integral':
        form.limit = numberFrom(step.limit, 'interval')
        break
      case 'time':
        form.duration = durationFrom(step.limit)
        break
      default:
        form.limit = String(step.limit)
    }
    return form
  }
  const steps: Step[] = detector.steps ?? []
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
    gates: (rule.gates ?? []).map((g) => gateFrom(g, units, shown)),
    shown
  }
}

export type ToRuleResult = { ok: true; rule: Rule } | { ok: false; errors: FieldError[] }

/** Collects the local errors of one conversion, each at its JSON pointer into the rule. */
class Reader {
  readonly errors: FieldError[] = []

  constructor(private readonly shown: ShownValues) {}

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
    optional = false
  ): number | undefined {
    if (text.trim() === '') {
      if (!optional) this.fail(path, 'is required')
      return undefined
    }
    const stored = this.shown[shownKey(text, kind, unit)]
    if (stored !== undefined) return stored
    const value = parsedNumber(text)
    if (value === undefined) {
      this.fail(path, 'must be a number')
      return undefined
    }
    return toSI(kind, value, unit)
  }

  duration(field: DurationField, path: string, optional = false): number | undefined {
    const value = this.number(field.amount, path, 'ratio', UNIT_ONE, optional)
    // Minutes and hours of a decimal amount leave float noise in the seconds.
    return value === undefined
      ? undefined
      : Number((value * DURATION_FACTORS[field.unit]).toPrecision(12))
  }

  value(field: ValueField, path: string, measure: Measure): number | string | boolean | undefined {
    switch (field.type) {
      case 'number':
        return this.number(field.text, path, measure.kind, measure.unit)
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
    return defined<Limit>({
      kind: 'zone',
      level: form.level,
      path: form.path === '' ? undefined : form.path
    })
  }
  const value = read.number(form.value, `${at}/value`, measure.kind, measure.unit)
  return value === undefined ? undefined : { kind: 'fixed', value }
}

function readEvent(form: EventForm, at: string, measure: Measure, read: Reader): Event {
  return defined({
    op: form.op,
    value: form.op === 'changesTo' ? read.value(form.value, `${at}/value`, measure) : undefined
  })
}

/** The step field its limit is stored in; none for a step that is its priority alone. */
export function stepLimitField(
  quantity: StepQuantity | undefined
): 'limit' | 'within' | 'value' | undefined {
  switch (quantity) {
    case undefined:
    case 'none':
      return undefined
    case 'within':
      return 'within'
    case 'match':
      return 'value'
    default:
      return 'limit'
  }
}

/** Where step `index` is in the rule. */
export function stepPointer(index: number): string {
  return `/detector/steps/${String(index)}`
}

function readSteps(form: RuleForm, measure: Measure, read: Reader): Step[] {
  const quantity = stepQuantity(form.detector)
  const field = stepLimitField(quantity) ?? ''
  return form.steps.map((step, i) => {
    const at = stepPointer(i)
    const limitAt = `${at}/${field}`
    const number = (kind: QuantityKind) => read.number(step.limit, limitAt, kind, measure.unit)
    const limit = (() => {
      switch (quantity) {
        case 'value':
          return { limit: number(measure.kind) }
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
    read.number(text, `${at}/hysteresis`, kindFor('interval', measure), measure.unit, true)
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
        hysteresis: hysteresis(d.hysteresis),
        clearDuration: read.duration(d.clearDuration, `${at}/clearDuration`, true)
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
          ? { op: d.whileOp, value: read.value(d.whileValue, `${at}/while/value`, measure) }
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
    direction: form.direction,
    limit: readLimit(form.limit, `${at}/limit`, measure, read),
    duration: read.duration(form.duration, `${at}/duration`, true),
    hysteresis: read.number(
      form.hysteresis,
      `${at}/hysteresis`,
      kindFor('interval', measure),
      measure.unit,
      true
    ),
    clearDuration: read.duration(form.clearDuration, `${at}/clearDuration`, true)
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
 * checks when the rule is saved.
 */
export function toRule(form: RuleForm, units: UnitLookup): ToRuleResult {
  const read = new Reader(form.shown)
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
