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
      return g.inputUnavailable
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
})
