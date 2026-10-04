/**
 * The editor's fields as JSON pointers into the rule: which it shows for the
 * rule as authored so far, where each error belongs, which lie under More
 * options, and how Save names what stops it.
 */
import type { FieldError } from '../api'
import { capitalised } from '../list/PriorityBadge'
import {
  ANGULAR_KINDS,
  canLatch,
  isZoneLimited,
  holdsFor,
  RETYPE_IN_UNIT,
  stepLimitFields,
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
    ...(ANGULAR_KINDS.has(signal.combinator) ? [`${at}/angular`] : [])
  ]
}

function limitPointers(limit: LimitForm, at: string): string[] {
  return limit.kind === 'zone'
    ? [`${at}/kind`, `${at}/level`, `${at}/path`]
    : [`${at}/kind`, `${at}/value`]
}

/**
 * The pointer whose errors the zones checkbox shows. A fixed detector limit
 * has no fields, typed steps standing in for it, so the checkbox, which
 * switches to and from the zones, holds every error under it.
 */
export function zonesPointer(limit: LimitForm): string {
  return limit.kind === 'zone' ? '/detector/limit/kind' : '/detector/limit'
}

function zoneLimitPointers(limit: LimitForm): string[] {
  return limit.kind === 'zone' ? limitPointers(limit, '/detector/limit') : [zonesPointer(limit)]
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
    case 'outside':
      return []
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
  const fields = stepLimitFields(stepQuantity(form.detector))
  return form.steps.flatMap((_, i) => {
    const at = stepPointer(i)
    return [`${at}/priority`, ...fields.map((field) => `${at}/${field}`)]
  })
}

/** The pointers of the fields under More options, for the rule as authored so far. */
function moreOptionsPointers(form: RuleForm, isNew: boolean): string[] {
  const d = form.detector
  return [
    ...(d.type === 'sustained' || d.type === 'outside'
      ? ['/detector/hysteresis', '/detector/clearDuration']
      : []),
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
    ...(d.type === 'sustained' || d.type === 'projection' ? zoneLimitPointers(d.limit) : []),
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
 * under, else on the first field of the group it names that is not a limit's
 * kind. An error on the gates as a whole stays off the fields: on the first
 * gate's it would read as that gate's own.
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
    const group =
      error.path === '/gates' ? [] : fields.filter((f) => f.startsWith(`${error.path}/`))
    // A limit's kind is always chosen, so an error on the whole limit is about the rest of it.
    const field = under ?? group.find((f) => !f.endsWith('/limit/kind')) ?? group.at(0)
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
  '/signal/inputs': 'the paths to combine',
  // Named for what it says, as a combination that cannot wrap angles shows no checkbox for it.
  '/signal/angular': 'whether the values are angles',
  '/detector/type': 'what should alert',
  '/detector/direction': 'the direction',
  '/detector/op': 'the state',
  '/detector/measure': 'what to total',
  '/detector/while': 'what to count while',
  '/detector/resetOn': 'the reset',
  '/detector/event': 'the event',
  '/detector/window': 'the window',
  '/detector/horizon': 'the time ahead',
  '/detector/duration': 'how long it must hold',
  '/detector/hysteresis': 'the clear margin',
  '/detector/clearDuration': 'the clear delay',
  '/detector/limit': "Use the value's zones",
  '/detector/limit/level': 'the zone to start at',
  '/detector/limit/path': 'the path of the zones',
  '/gates': 'the Only while conditions',
  '/latching': 'Keep the alert until acknowledged'
}

/** A field in words, as Save names it. */
export function fieldLabel(pointer: string, form: RuleForm): string {
  // An error on the steps as a whole is shown on the first step's priority.
  const step = /^\/detector\/steps(?:\/(\d+)(?:\/(\w+))?)?/.exec(pointer)
  if (step !== null) {
    const whole = pointer === '/detector/steps'
    const index = whole ? '0' : step[1]
    const field = whole ? 'priority' : step[2]
    if (form.steps.length > 1) return `step ${String(Number(index) + 1)}`
    if (field === 'priority') return 'the priority'
    if (field === 'low' || field === 'high') return `the ${field} limit`
    return stepQuantity(form.detector) === 'match' ? 'the state' : 'the limit'
  }
  const gate = /^\/gates\/(\d+)(.*)$/.exec(pointer)
  if (gate !== null) {
    const index = Number(gate[1])
    const condition = `Only while condition ${String(index + 1)}`
    const within = gate[2]
    const paths = `the paths of ${condition}`
    const path = `the path of ${condition}`
    if (/^\/limit(\/|$)/.test(within)) return `the limit of ${condition}`
    if (/^\/signal\/inputs(\/\d+(\/path)?)?$/.test(within)) return paths
    if (within === '/signal/path') return path
    if (within === '/direction') return `the direction of ${condition}`
    if (within === '/signal') return form.gates[index]?.signal.mode === 'combine' ? paths : path
    return condition
  }
  // A limit's direction is chosen with its kind, under Alert when.
  if (pointer === '/detector/direction' && form.detector.type === 'sustained') {
    return LABELS['/detector/type'] ?? ''
  }
  const input = /^\/signal\/inputs\/(\d+)/.exec(pointer)
  if (input !== null) return `path ${String(Number(input[1]) + 1)} to combine`
  const keys = Object.keys(LABELS)
  const known =
    keys
      .filter((key) => pointer === key || pointer.startsWith(`${key}/`))
      .sort((a, b) => b.length - a.length)
      .at(0) ??
    // A whole missing group is named by its first field, where attachErrors shows its error.
    keys.find((key) => key.startsWith(`${pointer}/`))
  return known === undefined ? 'a field under More options' : (LABELS[known] ?? '')
}

/** What Save says stops it: the fields to fill in, and those to fix. */
export function saveHint(errors: readonly FieldError[], form: RuleForm): string | undefined {
  const stops = whatStops(errors, form)
  return stops === undefined ? undefined : capitalised(`${stops} to save.`)
}

/** The fields to fill in and those to fix, as a phrase: "fill in the limit and fix the name". */
export function whatStops(errors: readonly FieldError[], form: RuleForm): string | undefined {
  // A clear margin to retype may stay empty, so it does not stop Save.
  const stopping = errors.filter((e) => e.message !== RETYPE_IN_UNIT)
  if (stopping.length === 0) return undefined
  const labels = (missing: boolean) => [
    ...new Set(
      stopping
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
