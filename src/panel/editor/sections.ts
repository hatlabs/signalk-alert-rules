/**
 * The editor's fields as JSON pointers into the rule: which it shows for the
 * rule as authored so far, where each error belongs, which lie under More
 * options, and how Save names what stops it.
 */
import type { FieldError } from '../api'
import { capitalised } from '../list/PriorityBadge'
import {
  canLatch,
  isZoneLimited,
  holdsFor,
  stepLimitField,
  stepPointer,
  stepQuantity,
  type DetectorForm,
  type EventForm,
  type LimitForm,
  type RuleForm,
  type SignalForm
} from './formModel'
import { joined } from './words'

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

/** The fields a condition kind shows above its steps. */
function conditionPointers(d: DetectorForm): string[] {
  const p = (field: string) => `/detector/${field}`
  switch (d.type) {
    case 'match':
      return [p('op')]
    case 'sustained':
      return [p('direction')]
    case 'slope':
      return [p('direction'), p('window')]
    case 'projection':
      return [p('direction'), p('window'), p('horizon')]
    case 'accumulator':
      return [
        p('measure'),
        ...(d.useWhile ? [p('while/op'), p('while/value')] : []),
        ...(d.useResetOn ? eventPointers(d.resetOn, p('resetOn')) : [])
      ]
    case 'count':
      return [...eventPointers(d.event, p('event')), p('window')]
    case 'absence':
      return eventPointers(d.event, p('event'))
    case '':
      return []
  }
}

function stepPointers(form: RuleForm): string[] {
  if (isZoneLimited(form.detector)) return []
  const field = stepLimitField(stepQuantity(form.detector))
  return form.steps.flatMap((_, i) => {
    const at = stepPointer(i)
    return field === undefined ? [`${at}/priority`] : [`${at}/priority`, `${at}/${field}`]
  })
}

/** The pointers of the fields under More options, for the rule as authored so far. */
function moreOptionsPointers(form: RuleForm, isNew: boolean): string[] {
  const d = form.detector
  return [
    ...(d.type === 'sustained' ? ['/detector/hysteresis', '/detector/clearDuration'] : []),
    ...(canLatch(d) ? ['/latching'] : []),
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
    ...(form.signal.mode === 'combine' ? signalPointers(form.signal, '/signal') : []),
    ...(d.type === 'sustained' || d.type === 'projection'
      ? limitPointers(d.limit, '/detector/limit')
      : []),
    ...(isNew ? ['/slug'] : [])
  ]
}

/** The JSON pointers of the fields the editor shows for the rule as authored so far, in order. */
export function fieldPointers(form: RuleForm, isNew: boolean): string[] {
  const d = form.detector
  return [
    '/name',
    ...(form.signal.mode === 'single' ? signalPointers(form.signal, '/signal') : []),
    '/detector/type',
    ...conditionPointers(d),
    ...stepPointers(form),
    ...(holdsFor(d) ? ['/detector/duration'] : []),
    '/message',
    '/condition',
    ...moreOptionsPointers(form, isNew)
  ]
}

/** Whether a field lies under More options, which opens to show its error. */
export function underMoreOptions(form: RuleForm, isNew: boolean, pointer: string): boolean {
  return moreOptionsPointers(form, isNew).includes(pointer)
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

const LABELS: Readonly<Record<string, string>> = {
  '/name': 'the name',
  '/slug': 'the slug',
  '/message': 'the message',
  '/condition': 'the condition name',
  '/signal/path': 'the value to watch',
  '/signal/source': 'the source',
  '/detector/type': 'what should alert',
  '/detector/direction': 'the direction',
  '/detector/op': 'the state',
  '/detector/measure': 'what to total',
  '/detector/while': 'what to total while',
  '/detector/resetOn': 'the reset',
  '/detector/event': 'the event',
  '/detector/window': 'the window',
  '/detector/horizon': 'the time ahead',
  '/detector/duration': 'how long it must hold',
  '/detector/hysteresis': 'the clear margin',
  '/detector/clearDuration': 'the clear delay',
  '/detector/limit': 'the zones',
  '/latching': 'Keep the alert until acknowledged'
}

/** A field in words, as Save names it. */
export function fieldLabel(pointer: string, form: RuleForm): string {
  const step = /^\/detector\/steps\/(\d+)(?:\/(\w+))?/.exec(pointer)
  if (step !== null) {
    if (form.steps.length > 1) return `step ${String(Number(step[1]) + 1)}`
    if (step[2] === 'priority') return 'the priority'
    return stepQuantity(form.detector) === 'match' ? 'the state' : 'the limit'
  }
  const gate = /^\/gates\/(\d+)/.exec(pointer)
  if (gate !== null) return `Only while condition ${String(Number(gate[1]) + 1)}`
  const input = /^\/signal\/inputs\/(\d+)/.exec(pointer)
  if (input !== null) return `path ${String(Number(input[1]) + 1)} to combine`
  const known = Object.keys(LABELS)
    .filter((key) => pointer === key || pointer.startsWith(`${key}/`))
    .sort((a, b) => b.length - a.length)
    .at(0)
  return known === undefined ? 'a field under More options' : (LABELS[known] ?? '')
}

/** What Save says stops it: the fields to fill in, and those to fix. */
export function saveHint(errors: readonly FieldError[], form: RuleForm): string | undefined {
  const stops = whatStops(errors, form)
  return stops === undefined ? undefined : capitalised(`${stops} to save.`)
}

/** The fields to fill in and those to fix, as a phrase: "fill in the limit and fix the name". */
export function whatStops(errors: readonly FieldError[], form: RuleForm): string | undefined {
  if (errors.length === 0) return undefined
  const labels = (missing: boolean) => [
    ...new Set(
      errors
        .filter((e) => (e.message === 'is required') === missing)
        .map((e) => fieldLabel(e.path, form))
    )
  ]
  const fill = labels(true)
  const fix = labels(false).filter((label) => !fill.includes(label))
  const parts = [
    ...(fill.length > 0 ? [`fill in ${joined(fill)}`] : []),
    ...(fix.length > 0 ? [`fix ${joined(fix)}`] : [])
  ]
  return parts.join(' and ')
}
