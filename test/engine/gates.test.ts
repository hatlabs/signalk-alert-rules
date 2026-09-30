import { describe, it, expect } from 'vitest'
import { Gate } from '../../src/engine/gates.js'
import type { Zone } from '../../src/engine/limits.js'
import type { Gate as GateModel } from '../../src/model/rule.js'
import type { Reading } from '../../src/engine/signals.js'

const IDLE = 8
const running: GateModel = {
  signal: { path: 'propulsion.main.revolutions' },
  direction: 'above',
  limit: { kind: 'fixed', value: IDLE },
  duration: 10
}

const v = (value: number): Reading => ({ available: true, value })
const TIMED_OUT: Reading = { available: false, timedOut: true }

function gate(model: GateModel, options: { adopted?: boolean; zones?: () => Zone[] } = {}) {
  const g = new Gate(model, options.zones ?? (() => undefined), 0)
  return {
    get holds() {
      return g.holdsFor(options.adopted ?? false)
    },
    get seen() {
      return g.seen
    },
    get inputUnavailable() {
      return g.input === 'unavailable'
    },
    get issue() {
      return g.issue
    },
    sample: (r: Reading, replayed: boolean, now: number) => {
      g.sample(r, replayed, now)
    },
    tick: (now: number) => {
      g.tick(now)
    }
  }
}

describe('gate', () => {
  it('holds once its condition has held for the duration and stops when it ends', () => {
    const g = gate(running)
    g.sample(v(30), false, 0)
    g.tick(9)
    expect(g.holds).toBe(false)
    g.tick(10)
    expect(g.holds).toBe(true)
    g.sample(v(0), false, 20)
    expect(g.holds).toBe(false)
  })

  it('a stopped engine whose rpm input then times out stays not holding', () => {
    const g = gate(running)
    g.sample(v(0), false, 0)
    g.sample(TIMED_OUT, false, 5)
    g.tick(1000)
    expect(g.holds).toBe(false)
    expect(g.inputUnavailable).toBe(true)
  })

  it('a running engine whose rpm input times out keeps holding', () => {
    const g = gate(running)
    g.sample(v(30), false, 0)
    g.tick(10)
    g.sample(TIMED_OUT, false, 20)
    g.tick(1000)
    expect(g.holds).toBe(true)
    expect(g.inputUnavailable).toBe(true)
    g.sample(v(30), false, 1001)
    expect(g.inputUnavailable).toBe(false)
  })

  it('a frozen gate ignores time and holds back its latest reading until the freeze ends', () => {
    let frozen = false
    const g = new Gate(
      running,
      () => undefined,
      0,
      () => (frozen ? {} : undefined)
    )
    g.sample(v(30), false, 0)
    frozen = true
    g.tick(10)
    expect(g.holdsFor(false)).toBe(false)
    g.sample(TIMED_OUT, false, 11)
    expect(g.input).toBe('unavailable')
    g.sample(v(0), false, 11)
    expect(g.holdsFor(false)).toBe(false)
    // Thawed, it evaluates the stopped engine it was sent while frozen.
    frozen = false
    g.tick(12)
    g.tick(30)
    expect(g.holdsFor(false)).toBe(false)
  })

  it('a gate rebuilt while frozen applies the reading it held back from its stored state', () => {
    let freeze: { holds: boolean } | undefined = { holds: true }
    const g = new Gate(
      running,
      () => undefined,
      0,
      () => freeze
    )
    g.sample(v(30), true, 0)
    g.tick(5)
    freeze = undefined
    g.tick(6)
    expect(g.holdsFor(false)).toBe(true)
  })

  it('a gate frozen before its first reading takes that reading without waiting out the duration', () => {
    let frozen = true
    const g = new Gate(
      running,
      () => undefined,
      0,
      () => (frozen ? {} : undefined)
    )
    g.sample(v(30), false, 0)
    expect(g.holdsFor(false)).toBe(true)
    g.tick(100)
    expect(g.holdsFor(false)).toBe(true)
    // Thawed, it goes on from the state it was frozen at rather than timing its duration again.
    frozen = false
    g.tick(101)
    expect(g.holdsFor(false)).toBe(true)
  })

  it('a gate with a stored state takes one reading for instances without one, and thaws from the stored state', () => {
    let freeze: { holds: boolean } | undefined = { holds: false }
    const g = new Gate(
      running,
      () => undefined,
      0,
      () => freeze
    )
    g.sample(v(30), false, 0)
    expect(g.seen).toBe(true)
    expect(g.holdsFor(false)).toBe(true)
    // The duration has not passed since the thaw, so the stored state decides.
    freeze = undefined
    g.tick(1)
    expect(g.holdsFor(false)).toBe(false)
  })

  it('an input never seen since start does not hold', () => {
    const g = gate(running)
    g.tick(1000)
    expect(g.holds).toBe(false)
    expect(g.seen).toBe(false)
  })

  it('for an adopted alert it holds from the first report without waiting for its duration', () => {
    const g = gate(running, { adopted: true })
    g.tick(1000)
    expect(g.holds).toBe(false)
    g.sample(v(30), false, 1001)
    expect(g.holds).toBe(true)
    g.sample(v(0), false, 1002)
    expect(g.holds).toBe(false)
  })

  it('takes a zone limit from the zones and follows them when they move', () => {
    let zones: Zone[] = [{ lower: 10, state: 'warn' }]
    const g = gate(
      { ...running, limit: { kind: 'zone', level: 'warn' }, duration: 0 },
      { zones: () => zones }
    )
    g.sample(v(12), false, 0)
    expect(g.holds).toBe(true)
    zones = [{ lower: 20, state: 'warn' }]
    g.tick(1)
    expect(g.holds).toBe(false)
  })

  it('a zone limit whose level is missing does not hold and says why', () => {
    const g = gate(
      { ...running, limit: { kind: 'zone', level: 'alarm' }, duration: 0 },
      { zones: () => [{ lower: 10, state: 'warn' }] }
    )
    g.sample(v(12), false, 0)
    expect(g.holds).toBe(false)
    expect(g.issue).toMatch(/no alarm zone/)
  })

  it('a zone limit pointing at the unzoned side of a path does not hold', () => {
    const rpm = (): Zone[] => [
      { lower: 3200, upper: 3600, state: 'warn' },
      { lower: 3600, upper: 4000, state: 'alarm' }
    ]
    const g = gate(
      { ...running, direction: 'below', limit: { kind: 'zone', level: 'warn' }, duration: 0 },
      { zones: rpm }
    )
    g.sample(v(1000), false, 0)
    expect(g.holds).toBe(false)
    expect(g.issue).toMatch(/no warn zone on the low side/)
  })

  it('a zone limit on a path zoned on both sides takes only its own side', () => {
    const zones = (): Zone[] => [
      { upper: 11.5, state: 'alarm' },
      { lower: 14.8, upper: 20, state: 'alarm' }
    ]
    const low = gate(
      { ...running, direction: 'below', limit: { kind: 'zone', level: 'alarm' }, duration: 0 },
      { zones }
    )
    const high = gate(
      { ...running, limit: { kind: 'zone', level: 'alarm' }, duration: 0 },
      { zones }
    )
    low.sample(v(12.8), false, 0)
    high.sample(v(12.8), false, 0)
    expect(low.holds).toBe(false)
    expect(high.holds).toBe(false)
    low.sample(v(11), false, 1)
    high.sample(v(15), false, 1)
    expect(low.holds).toBe(true)
    expect(high.holds).toBe(true)
  })
})
