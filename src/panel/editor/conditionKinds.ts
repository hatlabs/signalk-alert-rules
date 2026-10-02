/**
 * What should alert, in plain words, and the detector each choice maps onto
 * (docs/rules.md, Detectors). The user picks a kind; the detector's own
 * vocabulary stays out of the editor.
 */
import type { SignalValue } from '../api'
import { withDetector, type DetectorForm, type RuleForm } from './formModel'

export type ConditionKind =
  'below' | 'above' | 'rate' | 'projection' | 'silent' | 'state' | 'often' | 'total' | 'missing'

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

export function kindInfo(kind: ConditionKind): KindInfo {
  const info = CONDITION_KINDS.find((k) => k.kind === kind)
  if (info === undefined) throw new Error(`unknown condition kind ${kind}`)
  return info
}

/** The kinds a value can have: a value that is not a number cannot be compared with a limit. */
export function kindsFor(value: SignalValue | undefined): readonly KindInfo[] {
  return value === undefined || typeof value === 'number'
    ? CONDITION_KINDS
    : CONDITION_KINDS.filter((k) => !k.numeric)
}

export function kindOf(d: DetectorForm): ConditionKind | undefined {
  switch (d.type) {
    case 'sustained':
      return d.direction === '' ? undefined : d.direction
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

function detectorOf(kind: ConditionKind, d: DetectorForm): Partial<DetectorForm> {
  switch (kind) {
    case 'below':
    case 'above':
      return { type: 'sustained', direction: kind }
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
      return { type: 'count' }
    case 'total':
      return { type: 'accumulator', measure: d.measure === '' ? 'time' : d.measure }
    case 'missing':
      return { type: 'absence' }
  }
}

/** The form with the condition kind chosen; see `withDetector` for what happens to the steps. */
export function withKind(form: RuleForm, kind: ConditionKind): RuleForm {
  return withDetector(form, detectorOf(kind, form.detector))
}
