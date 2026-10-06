/**
 * What should alert, in plain words, and the detector each choice maps onto
 * (docs/rules.md, Detectors). The user picks a kind; the detector's own
 * vocabulary stays out of the editor.
 */
import type { SignalValue } from '../api'
import type { FieldType } from '../paths/selfPaths'
import {
  withDetector,
  type DetectorForm,
  type EventForm,
  type EventOp,
  type RuleForm
} from './formModel'

export type ConditionKind =
  | 'below'
  | 'above'
  | 'outside'
  | 'rate'
  | 'projection'
  | 'silent'
  | 'state'
  | 'often'
  | 'total'
  | 'missing'

export interface KindInfo {
  kind: ConditionKind
  label: string
  example: string
  /** Offered at once; the others wait under More kinds. */
  main: boolean
  /** Compares the value with a number, so only a numeric value can have it. */
  numeric: boolean
}

export const CONDITION_KINDS: readonly KindInfo[] = [
  {
    kind: 'below',
    label: 'Below a limit',
    example: 'e.g. house bank voltage under 12.0 V for 30 s',
    main: true,
    numeric: true
  },
  {
    kind: 'above',
    label: 'Above a limit',
    example: 'e.g. coolant temperature over 95 °C',
    main: true,
    numeric: true
  },
  {
    kind: 'outside',
    label: 'Outside a range',
    example: 'e.g. heel more than 25° either way',
    main: true,
    numeric: true
  },
  {
    kind: 'rate',
    label: 'Changing too fast',
    example: 'e.g. air pressure falling more than 3 hPa in 3 hours',
    main: true,
    numeric: true
  },
  {
    kind: 'projection',
    label: 'Going to reach a limit',
    example: 'e.g. depth reaching 2.5 m within 2 min at this rate',
    main: true,
    numeric: true
  },
  {
    kind: 'silent',
    label: 'Stopped reporting',
    example: 'e.g. no new depth value for 30 s',
    main: true,
    numeric: false
  },
  {
    kind: 'state',
    label: 'A given state',
    example: 'e.g. inverter state is fault',
    main: false,
    numeric: false
  },
  {
    kind: 'often',
    label: 'Happening too often',
    example: 'e.g. bilge pump starting more than 4 times an hour',
    main: false,
    numeric: false
  },
  {
    kind: 'total',
    label: 'Running too long in total',
    example: 'e.g. engine running 250 h since its last service',
    main: false,
    numeric: false
  },
  {
    kind: 'missing',
    label: 'Not happening',
    example: 'e.g. no watch acknowledgement for 15 min',
    main: false,
    numeric: false
  }
]

/**
 * The kinds a value can have: a value that is not a number cannot be
 * compared with a limit. Without a value, a field's declared type decides.
 */
export function kindsFor(
  value: SignalValue | undefined,
  valueType?: FieldType
): readonly KindInfo[] {
  const numeric =
    value === undefined
      ? valueType === undefined || valueType === 'number'
      : typeof value === 'number'
  return numeric ? CONDITION_KINDS : CONDITION_KINDS.filter((k) => !k.numeric)
}

export function kindOf(d: DetectorForm): ConditionKind | undefined {
  switch (d.type) {
    case 'sustained':
      return d.direction === '' ? undefined : d.direction
    case 'outside':
      return 'outside'
    case 'slope':
      return 'rate'
    case 'projection':
      return 'projection'
    case 'match':
      return d.matchOp === 'timedOut' ? 'silent' : 'state'
    case 'count':
      return 'often'
    case 'accumulator':
      return 'total'
    case 'absence':
      return 'missing'
    case '':
      return undefined
  }
}

/**
 * The event, swapped for this kind's default while it is still the other
 * event kind's, untouched. A count of any change counts each start of a pump
 * twice, once on and once off, and a number changes on nearly every sample;
 * an absence expecting any change suits a heartbeat.
 */
function eventDefault(event: EventForm, other: EventOp, own: EventOp): EventForm {
  // A chosen true or false is a type with no text, so only an empty number is untouched.
  const untouched = event.value.type === 'number' && event.value.text === ''
  return event.op === other && untouched ? { ...event, op: own } : event
}

function detectorOf(kind: ConditionKind, d: DetectorForm): Partial<DetectorForm> {
  switch (kind) {
    case 'below':
    case 'above':
      return { type: 'sustained', direction: kind }
    case 'outside':
      // Its steps are always typed; zones left on would return with a later kind.
      return { type: 'outside', limit: { ...d.limit, kind: 'fixed' } }
    case 'rate':
      return { type: 'slope' }
    case 'projection':
      return { type: 'projection' }
    case 'silent':
      return { type: 'match', matchOp: 'timedOut' }
    case 'state':
      return {
        type: 'match',
        matchOp: d.matchOp === '' || d.matchOp === 'timedOut' ? 'equals' : d.matchOp
      }
    case 'often':
      return { type: 'count', event: eventDefault(d.event, 'changes', 'changesTo') }
    case 'total':
      return { type: 'accumulator', measure: d.measure === '' ? 'time' : d.measure }
    case 'missing':
      return { type: 'absence', event: eventDefault(d.event, 'changesTo', 'changes') }
  }
}

/** The form with the condition kind chosen; see `withDetector` for what happens to the steps. */
export function withKind(form: RuleForm, kind: ConditionKind): RuleForm {
  return withDetector(form, detectorOf(kind, form.detector))
}
