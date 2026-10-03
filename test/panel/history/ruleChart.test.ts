import { describe, expect, it } from 'vitest'
import type { RuleEntry } from '../../../src/panel/api'
import { withKind, type ConditionKind } from '../../../src/panel/editor/conditionKinds'
import { emptyForm, type RuleForm } from '../../../src/panel/editor/formModel'
import { detailChart, editorChart } from '../../../src/panel/history/ruleChart'
import type { PathEntry } from '../../../src/panel/paths/selfPaths'
import { unitLookup } from '../../../src/panel/signalUnits'
import { displayUnit } from '../../../src/panel/units'
import { ruleEntry } from '../fixtures'

const COOLANT = 'propulsion.port.coolantTemperature'
const STATE = 'electrical.inverters.main.state'

const celsius = displayUnit({
  units: 'K',
  displayUnits: { formula: 'value - 273.15', symbol: '°C' }
})
const paths: PathEntry[] = [
  { path: COOLANT, units: 'K', unit: celsius, value: 353.15 },
  { path: STATE, unit: displayUnit({}), value: 'invert' }
]
const units = unitLookup(paths, displayUnit({ units: 'm' }))

const rule = (overrides: Partial<RuleEntry['rule']> = {}) => ruleEntry({ rule: overrides }).rule

describe('detailChart', () => {
  it('charts a high limit with each bucket’s highest value, the limit in display units', () => {
    const spec = detailChart(
      rule({
        signal: { paths: [COOLANT] },
        detector: { type: 'sustained', direction: 'above' },
        steps: [{ limit: 368.15, priority: 'warning' }]
      }),
      units
    )
    expect(spec).toMatchObject({
      path: COOLANT,
      method: 'max',
      side: 'above',
      limits: [{ value: 95, priority: 'warning' }]
    })
    expect(spec?.measure.unit).toBe(celsius)
  })

  it('charts a low limit with each bucket’s lowest value, every step’s limit in order', () => {
    const spec = detailChart(
      rule({
        signal: { paths: [COOLANT] },
        detector: { type: 'sustained', direction: 'below' },
        steps: [
          { limit: 278.15, priority: 'warning' },
          { limit: 273.15, priority: 'alarm' }
        ]
      }),
      units
    )
    expect(spec?.method).toBe('min')
    expect(spec?.limits).toEqual([
      { value: 5, priority: 'warning' },
      { value: 0, priority: 'alarm' }
    ])
  })

  it('draws a projection’s limit on the side its trend heads for', () => {
    const spec = detailChart(
      rule({
        signal: { paths: [COOLANT] },
        detector: { type: 'projection', direction: 'rising' },
        steps: [{ limit: 373.15, priority: 'alarm' }]
      }),
      units
    )
    expect(spec).toMatchObject({
      method: 'max',
      side: 'above',
      limits: [{ value: 100 }],
      verdict: false
    })
  })

  it('lets the summary judge a sustained rule, which alerts on the recorded value', () => {
    const spec = detailChart(
      rule({
        signal: { paths: [COOLANT] },
        detector: { type: 'sustained', direction: 'above' },
        steps: [{ limit: 368.15, priority: 'warning' }]
      }),
      units
    )
    expect(spec?.verdict).toBe(true)
  })

  it('charts a rate of change without a limit, as the limit is not a value', () => {
    const spec = detailChart(
      rule({
        signal: { paths: [COOLANT] },
        detector: { type: 'slope', direction: 'rising' },
        steps: [{ limit: 0.01, priority: 'warning' }]
      }),
      units
    )
    expect(spec).toMatchObject({ method: 'average', side: 'above', limits: [] })
  })

  it('charts a zone limit without a line, as the zones are the path’s', () => {
    const spec = detailChart(
      rule({
        signal: { paths: [COOLANT] },
        detector: { type: 'sustained', direction: 'above', zoneLevel: 'alarm' },
        steps: []
      }),
      units
    )
    expect(spec?.limits).toEqual([])
  })

  it('charts nothing for a wildcard, a combined signal, a value that is not a number or a kind without a value limit', () => {
    const none = [
      rule({ signal: { paths: ['propulsion.*.coolantTemperature'] } }),
      rule({
        signal: { paths: [COOLANT, 'propulsion.stbd.coolantTemperature'], combinator: 'max' }
      }),
      rule({ signal: { paths: [STATE] }, detector: { type: 'sustained', direction: 'above' } }),
      rule({ signal: { paths: [COOLANT] }, detector: { type: 'match', op: 'equals' } }),
      rule({ signal: { paths: [COOLANT] }, detector: { type: 'accumulator', measure: 'time' } })
    ]
    expect(none.map((r) => detailChart(r, units))).toEqual(none.map(() => undefined))
  })

  it('charts the source the rule is pinned to, and the preferred one otherwise', () => {
    const pinned = detailChart(rule({ signal: { paths: [COOLANT] }, source: 'can0.35' }), units)
    expect(pinned?.source).toBe('can0.35')
    expect(detailChart(rule({ signal: { paths: [COOLANT] } }), units)?.source).toBeUndefined()
  })

  it('charts a path not reported now, which may still have history', () => {
    expect(
      detailChart(rule({ signal: { paths: ['tanks.fuel.main.currentLevel'] } }), units)
    ).toBeDefined()
  })
})

function form(kind: ConditionKind, path: string, edit: (f: RuleForm) => void = () => undefined) {
  const f = withKind(emptyForm(), kind)
  f.signal.slots[0] = { path, source: '' }
  edit(f)
  return f
}

describe('editorChart', () => {
  it('draws the limits as typed, in display units', () => {
    const spec = editorChart(
      form('above', COOLANT, (f) => {
        f.steps[0] = { ...f.steps[0], limit: '95,5', priority: 'warning' }
      }),
      units
    )
    expect(spec).toMatchObject({
      path: COOLANT,
      method: 'max',
      side: 'above',
      limits: [{ value: 95.5, priority: 'warning' }]
    })
  })

  it('charts the source typed for the path, and the preferred one while it is empty', () => {
    const pinned = form('below', COOLANT, (f) => {
      f.signal.slots[0].source = ' can0.35 '
    })
    expect(editorChart(pinned, units)?.source).toBe('can0.35')
    expect(editorChart(form('below', COOLANT), units)?.source).toBeUndefined()
  })

  it('leaves out a step whose limit is not a number yet', () => {
    const spec = editorChart(form('below', COOLANT), units)
    expect(spec).toMatchObject({ method: 'min', side: 'below', limits: [] })
  })

  it('draws no line for a zone limit', () => {
    const spec = editorChart(
      form('below', COOLANT, (f) => {
        f.steps[0] = { ...f.steps[0], limit: '5' }
        f.detector.limit = { ...f.detector.limit, kind: 'zone' }
      }),
      units
    )
    expect(spec?.limits).toEqual([])
  })

  it('charts nothing before a path or a kind is chosen, or for a kind without a value limit', () => {
    expect(editorChart(form('below', ''), units)).toBeUndefined()
    const unchosen = emptyForm()
    unchosen.signal.slots[0] = { path: COOLANT, source: '' }
    expect(editorChart(unchosen, units)).toBeUndefined()
    expect(editorChart(form('state', COOLANT), units)).toBeUndefined()
  })

  it('charts nothing for a combined signal, whose value the history does not record', () => {
    const combined = form('above', COOLANT, (f) => {
      f.signal = {
        ...f.signal,
        mode: 'combine',
        slots: [
          { path: COOLANT, source: '' },
          { path: 'propulsion.stbd.coolantTemperature', source: '' }
        ]
      }
    })
    expect(editorChart(combined, units)).toBeUndefined()
  })

  it('charts a rate of change by its trend', () => {
    const spec = editorChart(
      form('rate', COOLANT, (f) => {
        f.detector.trend = 'falling'
      }),
      units
    )
    expect(spec).toMatchObject({ method: 'average', side: 'below', limits: [] })
  })
})
