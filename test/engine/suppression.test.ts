import { describe, it, expect } from 'vitest'
import type { Value } from '@signalk/server-api'
import { RuleEvaluator } from '../../src/engine/evaluator.js'
import {
  signalPaths,
  type ActiveSuppression,
  type Suppressions
} from '../../src/engine/suppression.js'
import type { Rule } from '../../src/model/rule.js'
import { validateRule } from '../../src/model/validate.js'
import { FakeSubscriptionManager } from '../helpers/FakeSubscriptionManager.js'

function valid(rule: unknown): Rule {
  const result = validateRule(rule)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

const OIL = 'propulsion.port.oilPressure'
const STBD_OIL = 'propulsion.starboard.oilPressure'
const RPM = 'propulsion.port.revolutions'

const oilLow = valid({
  name: 'Oil pressure low',
  slug: 'oil-pressure-low',
  message: 'Oil pressure low on {instance}',
  priority: 'alarm',
  signal: { path: 'propulsion.*.oilPressure' },
  detector: { type: 'sustained', direction: 'below', limit: { kind: 'fixed', value: 100 } }
})

const portOilLow = valid({ ...oilLow, slug: 'port-oil-low', signal: { path: OIL } })

const oilMismatch = valid({
  ...oilLow,
  slug: 'oil-mismatch',
  signal: { combinator: 'absDifference', inputs: [{ path: OIL }, { path: STBD_OIL }] },
  detector: { type: 'sustained', direction: 'above', limit: { kind: 'fixed', value: 50 } }
})

const coolantHigh = valid({
  ...oilLow,
  slug: 'coolant-high',
  signal: { path: 'propulsion.port.coolantTemperature' },
  detector: { type: 'sustained', direction: 'above', limit: { kind: 'fixed', value: 368 } },
  gates: [{ signal: { path: RPM }, direction: 'above', limit: { kind: 'fixed', value: 8 } }]
})

/** Suppressions a test changes as it goes. */
class Controls implements Suppressions {
  ruleLevel: ActiveSuppression | undefined
  readonly paths = new Map<string, ActiveSuppression>()
  rule() {
    return this.ruleLevel
  }
  path(path: string) {
    return this.paths.get(path)
  }
}

function setup(rule: Rule) {
  const sm = new FakeSubscriptionManager()
  const controls = new Controls()
  let now = 0
  const log: [number, string, string][] = []
  const evaluator = new RuleEvaluator(
    rule,
    {
      subscriptions: sm,
      meta: () => undefined,
      timeoutSettings: () => undefined,
      clock: () => now
    },
    (e) => log.push([now, e.type, e.instance?.segment ?? '']),
    [],
    new Map(),
    { id: 'user.' + rule.slug, suppressions: controls }
  )
  evaluator.start()
  return {
    evaluator,
    controls,
    log,
    instances: () => evaluator.status().instances,
    at: (t: number, path?: string, value?: Value) => {
      now = t
      if (path === undefined) evaluator.tick()
      else sm.publish(path, 'src', value ?? null)
    },
    /** Applies a change of the suppressions at once, as the runner does. */
    apply: (t: number) => {
      now = t
      evaluator.refresh()
    }
  }
}

describe('signal paths', () => {
  it('binds a wildcard to the instance and lists every combinator input', () => {
    expect(signalPaths(oilLow.signal, { name: 'port', segment: 'port' })).toEqual([OIL])
    expect(signalPaths(oilMismatch.signal, undefined)).toEqual([OIL, STBD_OIL])
  })
})

describe('rule suppression', () => {
  it('clears an active alert at once and does not raise it while the condition holds', () => {
    const { at, apply, controls, log, instances } = setup(portOilLow)
    at(0, OIL, 50)
    expect(log).toEqual([[0, 'raise', '']])
    controls.ruleLevel = {}
    apply(5)
    expect(log).toEqual([
      [0, 'raise', ''],
      [5, 'clear', '']
    ])
    at(10, OIL, 40)
    at(20)
    expect(log).toHaveLength(2)
    expect(instances()[0]).toMatchObject({ active: false, suppression: { scope: 'rule' } })
  })

  it('raises the alert again as a new alert when the suppression ends while the condition holds', () => {
    const { at, apply, controls, log } = setup(portOilLow)
    controls.ruleLevel = {}
    at(0, OIL, 50)
    expect(log).toEqual([])
    controls.ruleLevel = undefined
    apply(30)
    expect(log).toEqual([[30, 'raise', '']])
  })

  it('reports the auto-end duration with the scope', () => {
    const { at, controls, instances } = setup(portOilLow)
    controls.ruleLevel = { autoEndAfter: 600 }
    at(0, OIL, 200)
    expect(instances()[0]?.suppression).toEqual({ scope: 'rule', autoEndAfter: 600 })
  })
})

describe('input suppression', () => {
  it('suppresses a rule whose detector reads the path', () => {
    const { at, apply, controls, log, instances } = setup(portOilLow)
    at(0, OIL, 50)
    controls.paths.set(OIL, {})
    apply(1)
    expect(log).toEqual([
      [0, 'raise', ''],
      [1, 'clear', '']
    ])
    expect(instances()[0]?.suppression).toEqual({ scope: 'input', path: OIL })
  })

  it('suppresses a combinator rule reading the path as one of its inputs', () => {
    const { at, controls, log } = setup(oilMismatch)
    controls.paths.set(STBD_OIL, {})
    at(0, OIL, 200)
    at(0, STBD_OIL, 50)
    expect(log).toEqual([])
  })

  it('suppresses only the wildcard instance whose path it is', () => {
    const { at, controls, log, instances } = setup(oilLow)
    controls.paths.set(OIL, {})
    at(0, OIL, 50)
    at(0, STBD_OIL, 50)
    expect(log).toEqual([[0, 'raise', 'starboard']])
    expect(instances().map((i) => i.suppression)).toEqual([
      { scope: 'input', path: OIL },
      undefined
    ])
  })

  it('leaves a rule that does not read the path alone', () => {
    const { at, controls, log } = setup(portOilLow)
    controls.paths.set(STBD_OIL, {})
    at(0, OIL, 50)
    expect(log).toEqual([[0, 'raise', '']])
  })

  it('freezes a gate reading the path in the state it holds', () => {
    const { at, apply, controls, log, instances } = setup(coolantHigh)
    at(0, RPM, 20)
    at(0, 'propulsion.port.coolantTemperature', 380)
    expect(log).toEqual([[0, 'raise', '']])
    controls.paths.set(RPM, {})
    apply(1)
    // The engine stops, but the frozen gate keeps the rule in use.
    at(2, RPM, 0)
    at(3)
    expect(log).toEqual([[0, 'raise', '']])
    expect(instances()[0]?.gates).toEqual([{ holds: true, input: 'value' }])
    expect(instances()[0]?.suppression).toBeUndefined()
    // The reading held back while frozen applies when the freeze ends, with no new sample.
    controls.paths.delete(RPM)
    apply(4)
    expect(log).toEqual([
      [0, 'raise', ''],
      [4, 'clear', '']
    ])
  })

  it('freezes a gate that does not hold as not holding', () => {
    const { at, controls, log } = setup(coolantHigh)
    at(0, RPM, 0)
    controls.paths.set(RPM, {})
    at(1, RPM, 20)
    at(2, 'propulsion.port.coolantTemperature', 380)
    expect(log).toEqual([])
  })
})

describe('clear time', () => {
  it('counts while the condition is clear with a value, and restarts when it holds again', () => {
    const { at, instances } = setup(portOilLow)
    expect(instances()[0]?.clearFor).toBeUndefined()
    at(0, OIL, 200)
    at(10)
    expect(instances()[0]?.clearFor).toBe(10)
    at(12, OIL, 50)
    expect(instances()[0]?.clearFor).toBeUndefined()
    at(15, OIL, 200)
    at(20)
    expect(instances()[0]?.clearFor).toBe(5)
  })

  it('counts while suppressed, since the detector keeps evaluating', () => {
    const { at, controls, instances } = setup(portOilLow)
    controls.ruleLevel = { autoEndAfter: 60 }
    at(0, OIL, 50)
    expect(instances()[0]?.clearFor).toBeUndefined()
    at(10, OIL, 200)
    at(70)
    expect(instances()[0]?.clearFor).toBe(60)
  })

  it('does not count while the input is unavailable', () => {
    const { at, instances } = setup(portOilLow)
    at(0, OIL, 200)
    at(10, OIL, null)
    at(20)
    expect(instances()[0]?.clearFor).toBeUndefined()
  })

  it('counts while a gate does not hold, since the rule is out of use', () => {
    const { at, instances } = setup(coolantHigh)
    at(0, RPM, 0)
    at(30)
    expect(instances()[0]?.clearFor).toBe(30)
  })
})
