import { describe, expect, it } from 'vitest'
import { withKind, type ConditionKind } from '../../../src/panel/editor/conditionKinds'
import {
  generatedMessage,
  generatedName,
  strayBraces,
  withGenerated
} from '../../../src/panel/editor/message'
import {
  emptyForm,
  emptyStep,
  setCombinator,
  setMode,
  type RuleForm,
  type StepForm
} from '../../../src/panel/editor/formModel'
import type { PathEntry } from '../../../src/panel/paths/selfPaths'
import { unitLookup } from '../../../src/panel/signalUnits'
import { displayUnit } from '../../../src/panel/units'

const volts = displayUnit({ units: 'V', displayUnits: { formula: 'value', symbol: 'V' } })
const celsius = displayUnit({
  units: 'K',
  displayUnits: { formula: 'value - 273.15', symbol: '°C' }
})

const paths: PathEntry[] = [
  {
    path: 'electrical.batteries.bowthruster.voltage',
    displayName: 'Bow thruster bank voltage',
    units: 'V',
    unit: volts
  },
  { path: 'electrical.batteries.house.voltage', units: 'V', unit: volts },
  { path: 'propulsion.port.coolantTemperature', units: 'K', unit: celsius },
  { path: 'environment.depth.belowTransducer', units: 'm', unit: displayUnit({ units: 'm' }) },
  { path: 'electrical.switches.bilgePump.state', unit: displayUnit({}) }
]
const units = unitLookup(paths, displayUnit({ units: 'm' }))

function form(path: string, kind: ConditionKind, edit: (f: RuleForm) => void = () => undefined) {
  const f = withKind(emptyForm(), kind)
  f.signal.slots[0].path = path
  edit(f)
  return f
}

const step = (patch: Partial<StepForm>): StepForm => ({ ...emptyStep('warning'), ...patch })

describe('the generated message', () => {
  it('names the value by its display name, with the typed limit, duration and {value}', () => {
    const f = form('electrical.batteries.bowthruster.voltage', 'below', (f) => {
      f.steps = [step({ limit: '12.8' })]
      f.detector.duration = { amount: '30', unit: 's' }
    })
    expect(generatedMessage(f, units)).toBe(
      'Bow thruster bank voltage below 12.8 V for 30 s: {value}'
    )
  })

  it('names the value from its path without a display name, and leaves out no duration', () => {
    const f = form('propulsion.port.coolantTemperature', 'above', (f) => {
      f.steps = [step({ limit: '95' })]
    })
    expect(generatedMessage(f, units)).toBe('Port coolant temperature above 95 °C: {value}')
  })

  it('says {limit} for several steps, the limit of the step reached', () => {
    const f = form('electrical.batteries.house.voltage', 'below', (f) => {
      f.steps = [step({ limit: '12.2' }), step({ limit: '11.8', priority: 'alarm' })]
      f.detector.duration = { amount: '30', unit: 's' }
    })
    expect(generatedMessage(f, units)).toBe('House voltage below {limit} for 30 s: {value}')
  })

  it('says out of range, with the range of a single step as typed', () => {
    const f = form('propulsion.port.coolantTemperature', 'outside', (f) => {
      f.steps = [step({ low: '60', high: '95' })]
      f.detector.duration = { amount: '30', unit: 's' }
    })
    expect(generatedMessage(f, units)).toBe(
      'Port coolant temperature out of range 60 to 95 °C for 30 s: {value}'
    )
    expect(generatedName(f, units)).toBe('Port coolant temperature out of range')
  })

  it('says out of range alone for several steps or a range not yet typed', () => {
    const several = form('propulsion.port.coolantTemperature', 'outside', (f) => {
      f.steps = [step({ low: '60', high: '95' }), step({ low: '50', high: '100' })]
    })
    expect(generatedMessage(several, units)).toBe('Port coolant temperature out of range: {value}')
    const partial = form('propulsion.port.coolantTemperature', 'outside', (f) => {
      f.steps = [step({ low: '60' })]
    })
    expect(generatedMessage(partial, units)).toBe('Port coolant temperature out of range: {value}')
  })

  it('says {limit} until a limit is typed', () => {
    expect(generatedMessage(form('electrical.batteries.house.voltage', 'below'), units)).toBe(
      'House voltage below {limit}: {value}'
    )
  })

  it('names the instance of a wildcard rule', () => {
    const f = form('electrical.batteries.*.voltage', 'below', (f) => {
      f.steps = [step({ limit: '12' })]
    })
    expect(generatedMessage(f, units)).toBe('Voltage of {instance} below 12 V: {value}')
  })

  it.each<[ConditionKind, (f: RuleForm) => void, string]>([
    ['silent', () => undefined, 'Depth below transducer has stopped reporting'],
    [
      'state',
      (f) => {
        f.steps = [step({ value: { type: 'text', text: 'fault' } })]
      },
      'Depth below transducer is fault'
    ],
    [
      'often',
      (f) => {
        f.detector.event = { ...f.detector.event, op: 'changes' }
        f.steps = [step({ limit: '4' })]
        f.detector.window = { amount: '1', unit: 'h' }
      },
      'Depth below transducer changed more than 4 times in 1 h'
    ],
    [
      'missing',
      (f) => {
        f.steps = [step({ duration: { amount: '15', unit: 'min' } })]
      },
      'Depth below transducer has not changed for 15 min'
    ],
    [
      'total',
      (f) => {
        f.steps = [step({ duration: { amount: '250', unit: 'h' } })]
      },
      'Depth below transducer total reached 250 h'
    ],
    [
      'projection',
      (f) => {
        f.detector.trend = 'falling'
        f.steps = [step({ limit: '2.5' })]
        f.detector.horizon = { amount: '2', unit: 'min' }
      },
      'Depth below transducer falling to 2.5 m within 2 min: {value}'
    ],
    [
      'rate',
      (f) => {
        f.detector.trend = 'falling'
        f.steps = [step({ limit: '0.1' })]
      },
      'Depth below transducer falling faster than 0.1 m/min: {value}'
    ]
  ])('words a rule that alerts when %s', (kind, edit, expected) => {
    expect(generatedMessage(form('environment.depth.belowTransducer', kind, edit), units)).toBe(
      expected
    )
  })

  it('names a combination by its inputs', () => {
    const f = withKind(emptyForm(), 'above')
    f.signal = setCombinator(setMode(f.signal, 'combine'), 'absDifference')
    f.signal.slots[0].path = 'electrical.batteries.house.voltage'
    f.signal.slots[1].path = 'electrical.batteries.bowthruster.voltage'
    f.steps = [step({ limit: '1' })]
    expect(generatedMessage(f, units)).toBe(
      'Difference of house voltage and bow thruster bank voltage above 1 V: {value}'
    )
  })
})

describe('the generated name', () => {
  it.each<[ConditionKind, string]>([
    ['below', 'Bow thruster bank voltage low'],
    ['above', 'Bow thruster bank voltage high'],
    ['silent', 'Bow thruster bank voltage not reporting'],
    ['often', 'Bow thruster bank voltage changing often']
  ])('names a rule that alerts when %s', (kind, expected) => {
    expect(generatedName(form('electrical.batteries.bowthruster.voltage', kind), units)).toBe(
      expected
    )
  })
})

describe('withGenerated', () => {
  it('writes the message, name and slug of a new rule until each is edited', () => {
    const f = form('electrical.batteries.bowthruster.voltage', 'below', (f) => {
      f.steps = [step({ limit: '12.8' })]
    })
    const written = withGenerated(f, units)
    expect(written).toMatchObject({
      name: 'Bow thruster bank voltage low',
      slug: 'bow-thruster-bank-voltage-low',
      message: 'Bow thruster bank voltage below 12.8 V: {value}'
    })
    const edited = { ...written, message: 'Mine', messageFollows: false }
    edited.steps = [step({ limit: '12' })]
    expect(withGenerated(edited, units).message).toBe('Mine')
  })

  it('keeps the slug following a typed name until the slug is edited', () => {
    const f = form('electrical.batteries.bowthruster.voltage', 'below')
    const typed = { ...withGenerated(f, units), name: 'Thruster low', nameFollows: false }
    expect(withGenerated(typed, units).slug).toBe('thruster-low')
    const ownSlug = { ...typed, slug: 'mine', slugFollowsName: false }
    expect(withGenerated(ownSlug, units).slug).toBe('mine')
  })

  it('leaves a stored rule as it is', () => {
    const f = form('electrical.batteries.bowthruster.voltage', 'below', (f) => {
      Object.assign(f, { name: 'n', slug: 's', message: 'm', nameFollows: false })
      f.messageFollows = false
      f.slugFollowsName = false
    })
    expect(withGenerated(f, units)).toBe(f)
  })
})

describe('strayBraces', () => {
  it('finds brace text that is not a placeholder, and placeholders after a $', () => {
    expect(strayBraces('{value} {Value} { limit } ${value} {instance}')).toEqual([
      '{Value}',
      '{ limit }',
      '${value}'
    ])
    expect(strayBraces('Voltage {value}')).toEqual([])
  })
})
