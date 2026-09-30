/**
 * The authoring form's sections: which apply to the rule as authored so far,
 * which a new rule reveals, and which field each error belongs to.
 */
import type { FieldError } from '../api'
import type { UnitLookup } from '../signalUnits'
import {
  canLatch,
  isZoneLimited,
  matchTakesDuration,
  matchTakesValue,
  slotUnitErrors,
  type DetectorForm,
  type DurationField,
  type EventForm,
  type LimitForm,
  type RuleForm,
  type SignalForm,
  type ValueField
} from './formModel'

export const SECTIONS = [
  'inputs',
  'detect',
  'limit',
  'timing',
  'advanced',
  'message',
  'gates',
  'name'
] as const
export type SectionId = (typeof SECTIONS)[number]

const filled = (text: string) => text.trim() !== ''
const durationFilled = (d: DurationField) => filled(d.amount)
const valueFilled = (v: ValueField) => v.type !== 'number' || filled(v.text)
const eventComplete = (e: EventForm) => e.op !== 'changesTo' || valueFilled(e.value)

function limitComplete(limit: LimitForm): boolean {
  return limit.kind === 'zone' || filled(limit.value)
}

function hasLimit(d: DetectorForm): boolean {
  return d.type === 'match' ? matchTakesValue(d.matchOp) : d.type !== 'absence' && d.type !== ''
}

function hasTiming(d: DetectorForm): boolean {
  return d.type === 'match'
    ? matchTakesDuration(d.matchOp)
    : d.type !== 'accumulator' && d.type !== ''
}

export function sectionApplies(form: RuleForm, id: SectionId): boolean {
  const d = form.detector
  switch (id) {
    case 'limit':
      return hasLimit(d)
    case 'timing':
      return hasTiming(d)
    case 'advanced':
      return d.type === 'sustained' || canLatch(d)
    default:
      return true
  }
}

function signalComplete(signal: SignalForm, units: UnitLookup): boolean {
  return (
    signal.slots.every((s) => filled(s.path)) &&
    slotUnitErrors(signal, units).every((e) => e === undefined)
  )
}

function detectComplete(d: DetectorForm): boolean {
  switch (d.type) {
    case '':
      return false
    case 'match':
      return d.matchOp !== ''
    case 'sustained':
      return d.direction !== ''
    case 'slope':
    case 'projection':
      return d.trend !== ''
    case 'accumulator':
      return (
        d.measure !== '' &&
        (!d.useWhile || valueFilled(d.whileValue)) &&
        (!d.useResetOn || eventComplete(d.resetOn))
      )
    case 'count':
    case 'absence':
      return eventComplete(d.event)
  }
}

function limitSectionComplete(d: DetectorForm): boolean {
  switch (d.type) {
    case 'match':
      return valueFilled(d.matchValue)
    case 'sustained':
    case 'projection':
      return limitComplete(d.limit)
    case 'slope':
      return filled(d.slopeLimit)
    case 'accumulator':
      return d.measure === 'time' ? durationFilled(d.timeLimit) : filled(d.integralLimit)
    case 'count':
      return filled(d.countLimit)
    default:
      return true
  }
}

function timingComplete(d: DetectorForm): boolean {
  switch (d.type) {
    case 'match':
      return d.matchOp !== 'timedOut' || durationFilled(d.duration)
    case 'slope':
    case 'count':
      return durationFilled(d.window)
    case 'projection':
      return durationFilled(d.window) && durationFilled(d.horizon)
    case 'absence':
      return durationFilled(d.within)
    default:
      return true
  }
}

function sectionComplete(form: RuleForm, id: SectionId, units: UnitLookup): boolean {
  switch (id) {
    case 'inputs':
      return signalComplete(form.signal, units)
    case 'detect':
      return detectComplete(form.detector)
    case 'limit':
      return limitSectionComplete(form.detector)
    case 'timing':
      return timingComplete(form.detector)
    case 'message':
      return filled(form.message) && (isZoneLimited(form.detector) || form.priority !== '')
    case 'name':
      return filled(form.name) && filled(form.slug)
    case 'advanced':
    case 'gates':
      return true
  }
}

/**
 * The sections a new rule shows: those that apply, in order, up to and
 * including the first one not complete yet.
 */
export function revealedSections(form: RuleForm, units: UnitLookup): SectionId[] {
  const shown: SectionId[] = []
  for (const id of SECTIONS) {
    if (!sectionApplies(form, id)) continue
    shown.push(id)
    if (!sectionComplete(form, id, units)) break
  }
  return shown
}

function signalPointers(signal: SignalForm, at: string): string[] {
  if (signal.mode === 'single') return [`${at}/path`, `${at}/source`]
  return [
    `${at}/combinator`,
    ...signal.slots.flatMap((_, i) => [
      `${at}/inputs/${String(i)}/path`,
      `${at}/inputs/${String(i)}/source`
    ]),
    `${at}/angular`
  ]
}

function limitPointers(limit: LimitForm, at: string): string[] {
  return limit.kind === 'zone'
    ? [`${at}/kind`, `${at}/level`, `${at}/path`]
    : [`${at}/kind`, `${at}/value`]
}

function eventPointers(event: EventForm, at: string): string[] {
  return event.op === 'changesTo' ? [`${at}/op`, `${at}/value`] : [`${at}/op`]
}

function detectorPointers(d: DetectorForm): string[] {
  const at = '/detector'
  const p = (field: string) => `${at}/${field}`
  switch (d.type) {
    case '':
      return [p('type')]
    case 'match':
      return [
        p('type'),
        p('op'),
        ...(matchTakesValue(d.matchOp) ? [p('value')] : []),
        ...(matchTakesDuration(d.matchOp) ? [p('duration')] : [])
      ]
    case 'sustained':
      return [
        p('type'),
        p('direction'),
        ...limitPointers(d.limit, p('limit')),
        p('duration'),
        p('hysteresis'),
        p('clearDuration')
      ]
    case 'slope':
      return [p('type'), p('direction'), p('limit'), p('window')]
    case 'projection':
      return [
        p('type'),
        p('direction'),
        ...limitPointers(d.limit, p('limit')),
        p('window'),
        p('horizon')
      ]
    case 'accumulator':
      return [
        p('type'),
        p('measure'),
        ...(d.useWhile ? [p('while/op'), p('while/value')] : []),
        ...(d.useResetOn ? eventPointers(d.resetOn, p('resetOn')) : []),
        p('limit')
      ]
    case 'count':
      return [p('type'), ...eventPointers(d.event, p('event')), p('limit'), p('window')]
    case 'absence':
      return [p('type'), ...eventPointers(d.event, p('event')), p('within')]
  }
}

/** The JSON pointers of the fields the form shows for the rule as authored so far, in order. */
export function fieldPointers(form: RuleForm): string[] {
  return [
    ...signalPointers(form.signal, '/signal'),
    ...detectorPointers(form.detector),
    ...(canLatch(form.detector) ? ['/latching'] : []),
    '/message',
    ...(isZoneLimited(form.detector) ? [] : ['/priority']),
    ...form.gates.flatMap((gate, i) => {
      const at = `/gates/${String(i)}`
      return [
        ...signalPointers(gate.signal, `${at}/signal`),
        `${at}/direction`,
        ...limitPointers(gate.limit, `${at}/limit`),
        `${at}/duration`,
        `${at}/hysteresis`,
        `${at}/clearDuration`
      ]
    }),
    '/name',
    '/slug'
  ]
}

export interface AttachedErrors {
  /** Messages by the pointer of the field that shows them. */
  byField: Map<string, string[]>
  /** Errors no shown field can hold; the form lists them above the save button. */
  unattached: FieldError[]
}

/**
 * Puts each error on the field it names, else on the closest field it lies
 * under, else on the first field of the group it names.
 */
export function attachErrors(
  errors: readonly FieldError[],
  fields: readonly string[]
): AttachedErrors {
  const byField = new Map<string, string[]>()
  const unattached: FieldError[] = []
  for (const error of errors) {
    const under = fields
      .filter((f) => error.path === f || error.path.startsWith(`${f}/`))
      .sort((a, b) => b.length - a.length)
      .at(0)
    const field = under ?? fields.find((f) => f.startsWith(`${error.path}/`))
    if (field === undefined) unattached.push(error)
    else byField.set(field, [...(byField.get(field) ?? []), error.message])
  }
  return { byField, unattached }
}
