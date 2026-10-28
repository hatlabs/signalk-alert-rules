import { describe, it, expect } from 'vitest'
import { renderMessage } from '../../src/alerts/message.js'
import { signalUnits } from '../../src/alerts/messageUnits.js'
import type { Rule } from '../../src/model/rule.js'
import { validateRule } from '../../src/model/validate.js'

function valid(rule: unknown): Rule {
  const result = validateRule(rule)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return result.value
}

const battery = (message: string) =>
  valid({
    name: 'House bank low',
    slug: 'house-bank-low',
    message,
    signal: { path: 'electrical.batteries.*.voltage' },
    detector: {
      type: 'sustained',
      direction: 'below',
      steps: [
        { limit: 11.8, priority: 'warning' },
        { limit: 11.5, priority: 'alarm' }
      ],
      duration: 30
    }
  })

describe('renderMessage', () => {
  it('fills in the limit, duration, value and instance', () => {
    const rule = battery('{instance} voltage below {limit} for {duration}: {value}')
    expect(
      renderMessage(rule, { instance: 'house', value: 11.7, step: 0, limit: 11.8, units: 'V' })
    ).toBe('house voltage below 11.8 V for 30 s: 11.7 V')
  })

  it('renders the limit it is given, the reached step’s', () => {
    const rule = battery('below {limit}')
    expect(renderMessage(rule, { step: 1, limit: 11.5, units: 'V' })).toBe('below 11.5 V')
  })

  it('shows a dash for a placeholder with nothing to fill it in, and leaves other braces as written', () => {
    const zone = valid({
      ...battery('{limit} {value} {speed} {Value} {instance}'),
      detector: { type: 'sustained', direction: 'below', limit: { kind: 'zone', level: 'warn' } }
    })
    expect(renderMessage(zone, { step: 0 })).toBe('– – {speed} {Value} ')
  })

  it("takes a typed step's limit from the rule until the evaluator has resolved it", () => {
    expect(renderMessage(battery('{limit}'), { step: 1, units: 'V' })).toBe('11.5 V')
  })

  it('prefers the limit the facts carry over the rule’s step', () => {
    expect(renderMessage(battery('{limit}'), { step: 0, limit: 11.9, units: 'V' })).toBe('11.9 V')
  })

  it('without a step, names only the limit the facts carry', () => {
    expect(renderMessage(battery('{limit}'), { limit: 11.8, units: 'V' })).toBe('11.8 V')
    expect(renderMessage(battery('{limit}'), {})).toBe('–')
  })

  it('leaves a message without placeholders as it is', () => {
    const rule = battery('House battery voltage is low')
    expect(renderMessage(rule, { instance: 'house', value: 11.7, step: 0, limit: 11.8 })).toBe(
      'House battery voltage is low'
    )
  })

  it('shows a value without a known unit as a bare number, and rounds noise away', () => {
    const rule = battery('{value} {limit}')
    expect(renderMessage(rule, { value: 12.345678, step: 0, limit: 368.15 })).toBe('12.35 368.2')
  })

  it('shows a ratio without a display unit as a bare fraction', () => {
    const rule = battery('{value} of {limit}')
    expect(renderMessage(rule, { value: 0.153, step: 0, limit: 0.2, units: 'ratio' })).toBe(
      '0.153 of 0.2'
    )
  })

  it('shows strings, booleans and positions as they are', () => {
    const rule = battery('{value}')
    expect(renderMessage(rule, { value: 'faulted', step: 0 })).toBe('faulted')
    expect(renderMessage(rule, { value: true, step: 0 })).toBe('true')
    expect(renderMessage(rule, { value: { latitude: 60.1, longitude: 24.9 }, step: 0 })).toBe(
      '60.10000, 24.90000'
    )
  })

  it('renders the limit an outside rule went past, and a dash before it has gone past one', () => {
    const frequency = valid({
      name: 'Shore power frequency',
      slug: 'shore-power-frequency',
      message: 'Frequency {value}, past {limit}',
      signal: { path: 'electrical.ac.shore.frequency' },
      detector: {
        type: 'outside',
        steps: [
          { low: 49, high: 51, priority: 'warning' },
          { low: 48, high: 52, priority: 'alarm' }
        ]
      }
    })
    expect(renderMessage(frequency, { value: 47.5, step: 1, limit: 48, units: 'Hz' })).toBe(
      'Frequency 47.5 Hz, past 48 Hz'
    )
    expect(renderMessage(frequency, { value: 50, step: 0, units: 'Hz' })).toBe(
      'Frequency 50 Hz, past –'
    )
  })

  it('leaves an unfilled {limit} as written when asked, other placeholders still dashed', () => {
    const zone = valid({
      ...battery('below {limit}: {value}'),
      detector: { type: 'sustained', direction: 'below', limit: { kind: 'zone', level: 'warn' } }
    })
    expect(renderMessage(zone, { step: 0 }, { keepUnfilledLimit: true })).toBe('below {limit}: –')
  })

  it('fills in a limit the facts carry even when an unfilled one would stay as written', () => {
    expect(
      renderMessage(
        battery('{limit}'),
        { step: 0, limit: 12, units: 'V' },
        { keepUnfilledLimit: true }
      )
    ).toBe('12 V')
  })

  it("renders each detector's limit in its own quantity", () => {
    const pump = 'electrical.switches.bilge.state'
    const count = valid({
      name: 'Pump cycling',
      slug: 'pump-cycling',
      message: 'more than {limit} times',
      signal: { path: pump },
      detector: {
        type: 'count',
        event: { op: 'changesTo', value: true },
        window: 3600,
        steps: [
          { limit: 3, priority: 'warning' },
          { limit: 6, priority: 'alarm' }
        ]
      }
    })
    expect(renderMessage(count, { step: 1 })).toBe('more than 6 times')
    expect(renderMessage(count, { step: 1, limit: 7 })).toBe('more than 7 times')

    const absence = valid({
      name: 'Quiet',
      slug: 'quiet',
      message: 'nothing for {limit}',
      signal: { path: pump },
      detector: {
        type: 'absence',
        event: { op: 'changes' },
        steps: [{ within: 600, priority: 'warning' }]
      }
    })
    expect(renderMessage(absence, { step: 0 })).toBe('nothing for 10 min')

    const slope = valid({
      name: 'Rising',
      slug: 'rising',
      message: 'rising faster than {limit}',
      signal: { path: 'propulsion.main.temperature' },
      detector: {
        type: 'slope',
        direction: 'rising',
        window: 60,
        steps: [{ limit: 0.05, priority: 'warning' }]
      }
    })
    expect(renderMessage(slope, { step: 0, units: 'K' })).toBe('rising faster than 0.05 K/s')

    const accumulator = (measure: 'time' | 'integral') =>
      valid({
        name: 'Running',
        slug: 'running',
        message: 'over {limit}',
        signal: { path: 'propulsion.main.revolutions' },
        detector: { type: 'accumulator', measure, steps: [{ limit: 7200, priority: 'caution' }] }
      })
    expect(renderMessage(accumulator('time'), { step: 0 })).toBe('over 2 h')
    expect(renderMessage(accumulator('integral'), { step: 0, units: 'Hz' })).toBe('over 7200 Hz·s')

    const match = valid({
      name: 'Pump on',
      slug: 'pump-on',
      message: 'pump {limit} for {duration}',
      signal: { path: pump },
      detector: {
        type: 'match',
        op: 'equals',
        steps: [{ value: true, priority: 'warning' }],
        duration: 300
      }
    })
    expect(renderMessage(match, { step: 0 })).toBe('pump true for 5 min')
  })

  it('leaves {duration} as written for a rule without one', () => {
    const rule = valid({
      name: 'Low',
      slug: 'low',
      message: 'low for {duration}',
      signal: { path: 'tanks.fuel.main.currentLevel' },
      detector: {
        type: 'sustained',
        direction: 'below',
        steps: [{ limit: 0.2, priority: 'alarm' }]
      }
    })
    expect(renderMessage(rule, { step: 0, limit: 0.2 })).toBe('low for –')
  })
})

describe('renderMessage in display units', () => {
  const celsius = { symbol: '°C', scale: 1, offset: -273.15 }
  const fahrenheit = { symbol: '°F', scale: 1.8, offset: -459.67 }
  const coolant = (detector: unknown, message = '{value} past {limit}') =>
    valid({
      name: 'Coolant',
      slug: 'coolant',
      message,
      signal: { path: 'propulsion.main.coolantTemperature' },
      detector
    })
  const high = {
    type: 'sustained',
    direction: 'above',
    steps: [{ limit: 368.15, priority: 'alarm' }]
  }

  it('converts a level through the whole formula and labels it with the display symbol', () => {
    expect(
      renderMessage(coolant(high), {
        value: 370.15,
        step: 0,
        limit: 368.15,
        units: 'K',
        display: celsius
      })
    ).toBe('97 °C past 95 °C')
    expect(
      renderMessage(coolant(high), {
        value: 368.15,
        step: 0,
        limit: 368.15,
        units: 'K',
        display: fahrenheit
      })
    ).toBe('203 °F past 203 °F')
  })

  it('converts a difference through the scale alone', () => {
    expect(
      renderMessage(coolant(high), {
        value: 5,
        step: 0,
        limit: 2,
        units: 'K',
        display: fahrenheit,
        difference: true
      })
    ).toBe('9 °F past 3.6 °F')
  })

  it('converts a slope rate and an accumulated total through the scale alone', () => {
    const slope = coolant(
      {
        type: 'slope',
        direction: 'rising',
        window: 60,
        steps: [{ limit: 0.05, priority: 'warning' }]
      },
      'rising faster than {limit}'
    )
    expect(renderMessage(slope, { step: 0, units: 'K', display: fahrenheit })).toBe(
      'rising faster than 0.09 °F/s'
    )
    const integral = coolant(
      { type: 'accumulator', measure: 'integral', steps: [{ limit: 100, priority: 'caution' }] },
      'over {limit}'
    )
    expect(renderMessage(integral, { step: 0, units: 'K', display: celsius })).toBe('over 100 °C·s')
  })

  it("converts a match step's number as a level", () => {
    const match = coolant(
      { type: 'match', op: 'equals', steps: [{ value: 373.15, priority: 'warning' }] },
      'at {limit}'
    )
    expect(renderMessage(match, { step: 0, units: 'K', display: celsius })).toBe('at 100 °C')
  })

  it('shows a ratio in its display unit and a count as a bare number', () => {
    const fuel = valid({
      name: 'Fuel',
      slug: 'fuel',
      message: '{value} below {limit}',
      signal: { path: 'tanks.fuel.main.currentLevel' },
      detector: {
        type: 'sustained',
        direction: 'below',
        steps: [{ limit: 0.2, priority: 'alarm' }]
      }
    })
    const percent = { symbol: '%', scale: 100, offset: 0 }
    expect(
      renderMessage(fuel, { value: 0.153, step: 0, limit: 0.2, units: 'ratio', display: percent })
    ).toBe('15.3 % below 20 %')
    // An admin who picks the ratio conversion gets the fraction.
    const fraction = { symbol: '', scale: 1, offset: 0 }
    expect(
      renderMessage(fuel, { value: 0.153, step: 0, limit: 0.2, units: 'ratio', display: fraction })
    ).toBe('0.153 below 0.2')
    const count = valid({
      name: 'Cycling',
      slug: 'cycling',
      message: 'more than {limit} times',
      signal: { path: 'electrical.switches.bilge.state' },
      detector: {
        type: 'count',
        event: { op: 'changesTo', value: true },
        window: 3600,
        steps: [{ limit: 6, priority: 'warning' }]
      }
    })
    expect(renderMessage(count, { step: 0, units: 'K', display: celsius })).toBe(
      'more than 6 times'
    )
  })
})

describe('signalUnits', () => {
  const meta = (units: Record<string, string>) => (path: string) => ({ units: units[path] })

  it("reads a path's units, with the instance in place of the wildcard", () => {
    const signal = { path: 'electrical.batteries.*.voltage' }
    const units = meta({ 'electrical.batteries.house.voltage': 'V' })
    expect(signalUnits(signal, { name: 'house', segment: 'house' }, units)).toBe('V')
    expect(signalUnits(signal, undefined, units)).toBeUndefined()
  })

  it("reads a field's units, with the instance in place of a wildcard before the pointer", () => {
    const signal = { path: 'electrical.batteries.*#/voltage' }
    const units = meta({ 'electrical.batteries.house#/voltage': 'V' })
    expect(signalUnits(signal, { name: 'house', segment: 'house' }, units)).toBe('V')
  })

  it("renders a field's value and limit in the field's units", () => {
    const heel = valid({
      name: 'Heel',
      slug: 'heel',
      message: 'Roll {value} past {limit}',
      signal: { path: 'navigation.attitude#/roll' },
      detector: { type: 'outside', steps: [{ low: -0.35, high: 0.35, priority: 'warning' }] }
    })
    const units = signalUnits(heel.signal, undefined, meta({ 'navigation.attitude#/roll': 'rad' }))
    expect(renderMessage(heel, { value: 0.4, step: 0, limit: 0.35, units })).toBe(
      'Roll 0.4 rad past 0.35 rad'
    )
  })

  it('reads a combination’s units from its first input that has them', () => {
    const units = meta({ b: 'K' })
    const inputs = [{ path: 'a' }, { path: 'b' }]
    expect(signalUnits({ combinator: 'difference', inputs }, undefined, units)).toBe('K')
    expect(signalUnits({ combinator: 'ratio', inputs }, undefined, units)).toBeUndefined()
    expect(signalUnits({ combinator: 'distance', inputs }, undefined, units)).toBe('m')
  })
})
