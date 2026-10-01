/**
 * The authoring form's state and its conversion to and from a rule.
 *
 * The form holds what the user typed: numbers as text in the display unit of
 * the path they apply to, durations as an amount and a unit. `toRule` turns
 * that into an SI rule, and `fromRule` shows a stored rule the same way, so a
 * rule survives the round trip. Every detector's fields live side by side,
 * so switching the detector type does not lose what was typed for another.
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
  ZoneLevel
} from '../../model/rule'
import type { FieldError } from '../api'
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

export type DetectorType = Detector['type']
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
  matchValue: ValueField
  direction: 'above' | 'below' | ''
  trend: 'rising' | 'falling' | ''
  limit: LimitForm
  slopeLimit: string
  measure: 'time' | 'integral' | ''
  useWhile: boolean
  whileOp: StateOp
  whileValue: ValueField
  useResetOn: boolean
  resetOn: EventForm
  timeLimit: DurationField
  integralLimit: string
  event: EventForm
  countLimit: string
  duration: DurationField
  window: DurationField
  horizon: DurationField
  within: DurationField
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

export interface RuleForm {
  name: string
  slug: string
  /** The slug is still derived from the name: a new rule whose slug nobody edited. */
  slugFollowsName: boolean
  message: string
  priority: Priority | ''
  latching: boolean
  signal: SignalForm
  detector: DetectorForm
  gates: GateForm[]
  shown: ShownValues
}

const UNIT_ONE: DisplayUnit = { symbol: '', scale: 1, offset: 0, si: true }

const noDuration = (): DurationField => ({ amount: '', unit: 's' })
const noValue = (): ValueField => ({ type: 'number', text: '' })
const noLimit = (): LimitForm => ({ kind: 'fixed', value: '', level: 'warn', path: '' })
const noSlot = (): SlotForm => ({ path: '', source: '' })

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
    message: '',
    priority: '',
    latching: false,
    signal: emptySignal(),
    detector: {
      type: '',
      matchOp: '',
      matchValue: noValue(),
      direction: '',
      trend: '',
      limit: noLimit(),
      slopeLimit: '',
      measure: '',
      useWhile: false,
      whileOp: 'above',
      whileValue: noValue(),
      useResetOn: false,
      resetOn: { op: 'changes', value: noValue() },
      timeLimit: noDuration(),
      integralLimit: '',
      event: { op: 'changes', value: noValue() },
      countLimit: '',
      duration: noDuration(),
      window: noDuration(),
      horizon: noDuration(),
      within: noDuration(),
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

function parsed(text: string): number | undefined {
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

/** A stored rule as the form shows it, numbers in the display units of its paths. */
export function fromRule(rule: Rule, units: UnitLookup): RuleForm {
  const form = emptyForm()
  const shown: ShownValues = {}
  const signal = signalFrom(rule.signal)
  const measure = signalMeasure(signalShape(signal), units)
  const d = form.detector
  const detector = rule.detector
  d.type = detector.type
  switch (detector.type) {
    case 'match':
      d.matchOp = detector.op
      d.matchValue = valueFrom(detector.value, measure, shown)
      d.duration = durationFrom(detector.duration)
      break
    case 'sustained':
      d.direction = detector.direction
      d.limit = limitFrom(detector.limit, measure, shown)
      d.duration = durationFrom(detector.duration)
      d.hysteresis =
        detector.hysteresis === undefined
          ? ''
          : shownNumber(detector.hysteresis, kindFor('interval', measure), measure.unit, shown)
      d.clearDuration = durationFrom(detector.clearDuration)
      break
    case 'slope':
      d.trend = detector.direction
      d.window = durationFrom(detector.window)
      d.slopeLimit = shownNumber(detector.limit, kindFor('slope', measure), measure.unit, shown)
      break
    case 'projection':
      d.trend = detector.direction
      d.limit = limitFrom(detector.limit, measure, shown)
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
      if (detector.measure === 'time') d.timeLimit = durationFrom(detector.limit)
      else
        d.integralLimit = shownNumber(
          detector.limit,
          kindFor('interval', measure),
          measure.unit,
          shown
        )
      break
    case 'count':
      d.event = eventFrom(detector.event, measure, shown)
      d.window = durationFrom(detector.window)
      d.countLimit = String(detector.limit)
      break
    case 'absence':
      d.event = eventFrom(detector.event, measure, shown)
      d.within = durationFrom(detector.within)
      break
  }
  return {
    ...form,
    name: rule.name,
    slug: rule.slug,
    slugFollowsName: false,
    message: rule.message,
    priority: rule.priority ?? '',
    latching: rule.latching === true,
    signal,
    detector: d,
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
    const value = parsed(text)
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

function readDetector(d: DetectorForm, measure: Measure, read: Reader): Detector | undefined {
  const at = '/detector'
  const interval = kindFor('interval', measure)
  const hysteresis = (text: string) =>
    read.number(text, `${at}/hysteresis`, interval, measure.unit, true)
  switch (d.type) {
    case '':
      read.fail(`${at}/type`, 'is required')
      return undefined
    case 'match': {
      const op = read.choice(d.matchOp, `${at}/op`)
      return defined({
        type: 'match',
        op,
        value: matchTakesValue(d.matchOp)
          ? read.value(d.matchValue, `${at}/value`, measure)
          : undefined,
        duration: matchTakesDuration(d.matchOp)
          ? read.duration(d.duration, `${at}/duration`, d.matchOp !== 'timedOut')
          : undefined
      }) as Detector
    }
    case 'sustained':
      return defined({
        type: 'sustained',
        direction: read.choice(d.direction, `${at}/direction`),
        limit: readLimit(d.limit, `${at}/limit`, measure, read),
        duration: read.duration(d.duration, `${at}/duration`, true),
        hysteresis: hysteresis(d.hysteresis),
        clearDuration: read.duration(d.clearDuration, `${at}/clearDuration`, true)
      }) as Detector
    case 'slope':
      return {
        type: 'slope',
        direction: read.choice(d.trend, `${at}/direction`) ?? 'rising',
        window: read.duration(d.window, `${at}/window`) ?? 0,
        limit:
          read.number(d.slopeLimit, `${at}/limit`, kindFor('slope', measure), measure.unit) ?? 0
      }
    case 'projection':
      return defined({
        type: 'projection',
        direction: read.choice(d.trend, `${at}/direction`),
        limit: readLimit(d.limit, `${at}/limit`, measure, read),
        window: read.duration(d.window, `${at}/window`),
        horizon: read.duration(d.horizon, `${at}/horizon`)
      }) as Detector
    case 'accumulator': {
      const measured = read.choice(d.measure, `${at}/measure`)
      return defined({
        type: 'accumulator',
        measure: measured,
        while: d.useWhile
          ? { op: d.whileOp, value: read.value(d.whileValue, `${at}/while/value`, measure) }
          : undefined,
        resetOn: d.useResetOn ? readEvent(d.resetOn, `${at}/resetOn`, measure, read) : undefined,
        limit:
          measured === 'time'
            ? read.duration(d.timeLimit, `${at}/limit`)
            : read.number(d.integralLimit, `${at}/limit`, interval, measure.unit)
      }) as Detector
    }
    case 'count':
      return defined({
        type: 'count',
        event: readEvent(d.event, `${at}/event`, measure, read),
        window: read.duration(d.window, `${at}/window`),
        limit: read.number(d.countLimit, `${at}/limit`, 'ratio', measure.unit)
      }) as Detector
    case 'absence':
      return defined({
        type: 'absence',
        event: readEvent(d.event, `${at}/event`, measure, read),
        within: read.duration(d.within, `${at}/within`)
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
  const zoned = isZoneLimited(form.detector)
  const priority = zoned ? undefined : read.choice(form.priority, '/priority')
  const signal = readSignal(form.signal, '/signal', units, read)
  const detector = readDetector(form.detector, measure, read)
  const gates = form.gates.map((g, i) => readGate(g, `/gates/${String(i)}`, units, read))
  if (read.errors.length > 0 || signal === undefined || detector === undefined) {
    return { ok: false, errors: read.errors }
  }
  const rule = defined({
    name,
    slug,
    message,
    priority,
    latching: form.latching && canLatch(form.detector) ? true : undefined,
    signal,
    detector,
    gates: gates.length > 0 ? gates : undefined
  }) as Rule
  return { ok: true, rule }
}
