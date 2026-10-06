import { describe, it, expect } from 'vitest'
import { bindPath, openSignal, type Reading, type Sample } from '../../src/engine/signals.js'
import { canonicalSourceRef } from '../../src/engine/sourceRefs.js'
import { MAX_INSTANCES, type Signal } from '../../src/model/rule.js'
import { FakeSubscriptionManager } from '../helpers/FakeSubscriptionManager.js'

const DEG = Math.PI / 180

function record(signal: Signal, subscriptions: FakeSubscriptionManager) {
  const samples: Sample[] = []
  const issues: string[] = []
  const close = openSignal(signal, subscriptions, {
    onSample: (s) => samples.push(s),
    onIssue: (m) => issues.push(m),
    onError: (e) => {
      throw e
    }
  })
  return { samples, issues, close }
}

function readings(samples: Sample[]): Reading[] {
  return samples.map((s) => s.reading)
}

function value(v: unknown): Reading {
  return { available: true, value: v } as Reading
}

describe('single path signal', () => {
  it('delivers the preferred source value', () => {
    const sm = new FakeSubscriptionManager(['n2k.1', 'n2k.2'])
    const { samples } = record({ path: 'environment.depth.belowTransducer' }, sm)
    sm.publish('environment.depth.belowTransducer', 'n2k.1', 4.2)
    sm.publish('environment.depth.belowTransducer', 'n2k.2', 9.9)
    expect(readings(samples)).toEqual([value(4.2)])
    expect(samples[0]?.instance).toBeUndefined()
    expect(samples[0]?.replayed).toBe(false)
  })

  it('a timed-out marker makes the signal unavailable, not zero', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record({ path: 'environment.depth.belowTransducer' }, sm)
    sm.publish('environment.depth.belowTransducer', 'n2k.1', 4.2)
    sm.timeOut('environment.depth.belowTransducer', 'n2k.1')
    expect(readings(samples)).toEqual([value(4.2), { available: false, timedOut: true }])
  })

  it('a plain null is unavailable without the timed-out flag', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record({ path: 'environment.depth.belowTransducer' }, sm)
    sm.publish('environment.depth.belowTransducer', 'n2k.1', null)
    expect(readings(samples)).toEqual([{ available: false, timedOut: false }])
  })

  it('a value of an unsupported shape is unavailable', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record({ path: 'navigation.attitude' }, sm)
    sm.publish('navigation.attitude', 'imu', { roll: 0.1, pitch: 0, yaw: 0 })
    sm.publish('navigation.attitude', 'imu', Number.NaN)
    expect(readings(samples)).toEqual([
      { available: false, timedOut: false },
      { available: false, timedOut: false }
    ])
  })

  it('keeps latitude and longitude of a position', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record({ path: 'navigation.position' }, sm)
    sm.publish('navigation.position', 'gnss', { latitude: 60, longitude: 25, altitude: 3 })
    expect(readings(samples)).toEqual([value({ latitude: 60, longitude: 25 })])
  })

  it('ignores paths the subscription pattern matches but the signal does not', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record({ path: 'propulsion.*.revolutions' }, sm)
    sm.publish('propulsion.port.drive.revolutions', 'n2k.1', 12)
    expect(samples).toEqual([])
  })
})

describe('$source-restricted input', () => {
  const path = 'navigation.headingMagnetic'

  it('receives a lower-ranked source and ignores the others', () => {
    const sm = new FakeSubscriptionManager(['compass.a', 'compass.b'])
    const { samples } = record({ path, source: 'compass.b' }, sm)
    sm.publish(path, 'compass.a', 1)
    sm.publish(path, 'compass.b', 2)
    sm.publish(path, 'compass.c', 3)
    expect(readings(samples)).toEqual([value(2)])
  })

  it("that source's timed-out marker makes it unavailable while another source still emits", () => {
    const sm = new FakeSubscriptionManager(['compass.a', 'compass.b'])
    const { samples } = record({ path, source: 'compass.b' }, sm)
    sm.publish(path, 'compass.b', 2)
    sm.timeOut(path, 'compass.b')
    sm.publish(path, 'compass.a', 1)
    expect(readings(samples)).toEqual([value(2), { available: false, timedOut: true }])
  })

  describe('of an NMEA 2000 device whose provider reports addresses', () => {
    const CAN_NAME = 'c0ffee0123456789'

    function device(src: string, canName?: string) {
      return { n2k: { src, ...(canName === undefined ? {} : { canName }), pgns: {} } }
    }

    function open(source: string) {
      return openOf({ path, source })
    }

    function openOf(signal: Signal) {
      const sources: Record<string, Record<string, unknown>> = {
        can0: { label: 'can0', type: 'NMEA2000', '10': device('10', CAN_NAME), '11': device('11') },
        nmea0183: { label: 'nmea0183', type: 'NMEA0183', GP: { talker: 'GP' } }
      }
      const sm = new FakeSubscriptionManager()
      const samples: Sample[] = []
      openSignal(
        signal,
        sm,
        {
          onSample: (s) => samples.push(s),
          onIssue: () => undefined,
          onError: (e) => {
            throw e
          }
        },
        (ref) => canonicalSourceRef(sources, ref)
      )
      return { sm, samples, sources }
    }

    it('a CAN name pin receives the address form of that device only', () => {
      const { sm, samples } = open(`can0.${CAN_NAME}`)
      sm.publish(path, 'can0.10', 1)
      sm.publish(path, 'can0.11', 2)
      expect(readings(samples)).toEqual([value(1)])
    })

    it('keeps receiving the device after it claims another address', () => {
      const { sm, samples, sources } = open(`can0.${CAN_NAME}`)
      sm.publish(path, 'can0.10', 1)
      sources.can0 = { ...sources.can0, '10': device('10'), '12': device('12', CAN_NAME) }
      sm.publish(path, 'can0.12', 2)
      sm.publish(path, 'can0.10', 3)
      expect(readings(samples)).toEqual([value(1), value(2)])
    })

    it('an address form pin receives the CAN name form of the same device', () => {
      const { sm, samples } = open('can0.10')
      sm.publish(path, `can0.${CAN_NAME}`, 1)
      expect(readings(samples)).toEqual([value(1)])
    })

    it('a combinator input pinned to a CAN name receives the address form of that device', () => {
      const other = 'navigation.headingTrue'
      const { sm, samples } = openOf({
        combinator: 'difference',
        inputs: [{ path, source: `can0.${CAN_NAME}` }, { path: other }]
      })
      sm.publish(path, 'can0.10', 30)
      sm.publish(path, 'can0.11', 99)
      sm.publish(other, 'can0.11', 28)
      expect(readings(samples)).toEqual([value(2)])
    })

    it('a source without a CAN name is matched as it is', () => {
      const { sm, samples } = open('nmea0183.GP')
      sm.publish(path, 'nmea0183.GP', 1)
      sm.publish(path, 'can0.10', 2)
      sm.publish(path, 'can0.11', 3)
      expect(readings(samples)).toEqual([value(1)])
    })
  })
})

describe('subscribe-time bootstrap', () => {
  it('a value still in the cache is available without a new delta, marked replayed', () => {
    const sm = new FakeSubscriptionManager()
    sm.publish('electrical.switches.bilgePump.state', 'relay', true)
    const { samples } = record({ path: 'electrical.switches.bilgePump.state' }, sm)
    expect(samples).toEqual([{ reading: value(true), replayed: true }])
    sm.publish('electrical.switches.bilgePump.state', 'relay', false)
    expect(samples[1]).toEqual({ reading: value(false), replayed: false })
  })

  it('a cached timed-out marker is replayed as unavailable', () => {
    const sm = new FakeSubscriptionManager()
    sm.timeOut('environment.depth.belowTransducer', 'n2k.1')
    const { samples } = record({ path: 'environment.depth.belowTransducer' }, sm)
    expect(samples).toEqual([{ reading: { available: false, timedOut: true }, replayed: true }])
  })
})

describe('wildcard instances', () => {
  it('discovers existing instances and adds new ones as they appear', () => {
    const sm = new FakeSubscriptionManager()
    sm.publish('propulsion.port.revolutions', 'n2k.1', 10)
    const { samples } = record({ path: 'propulsion.*.revolutions' }, sm)
    sm.publish('propulsion.starboard.revolutions', 'n2k.2', 11)
    expect(samples).toEqual([
      { instance: { name: 'port', segment: 'port' }, reading: value(10), replayed: true },
      { instance: { name: 'starboard', segment: 'starboard' }, reading: value(11), replayed: false }
    ])
  })

  it('carries a sanitised alert path segment for the instance', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record({ path: 'electrical.batteries.*.voltage' }, sm)
    sm.publish('electrical.batteries.house bank.voltage', 'bmv', 12.6)
    expect(samples[0]?.instance).toEqual({ name: 'house bank', segment: 'house_bank' })
  })

  it(`reports instances beyond ${String(MAX_INSTANCES)} once and delivers nothing for them`, () => {
    const sm = new FakeSubscriptionManager()
    const { samples, issues } = record({ path: 'tanks.fuel.*.currentLevel' }, sm)
    for (let i = 0; i <= MAX_INSTANCES; i++)
      sm.publish(`tanks.fuel.${String(i)}.currentLevel`, 's', 0.5)
    sm.publish(`tanks.fuel.${String(MAX_INSTANCES)}.currentLevel`, 's', 0.4)
    expect(samples).toHaveLength(MAX_INSTANCES)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatch(String(MAX_INSTANCES))
  })

  it('stops reporting rejected instances after as many as it admits', () => {
    const sm = new FakeSubscriptionManager()
    const { issues } = record({ path: 'tanks.fuel.*.currentLevel' }, sm)
    for (let i = 0; i < 3 * MAX_INSTANCES; i++)
      sm.publish(`tanks.fuel.${String(i)}.currentLevel`, 's', 0.5)
    expect(issues).toHaveLength(MAX_INSTANCES)
  })

  it('reports an instance whose segment collides with an existing one', () => {
    const sm = new FakeSubscriptionManager()
    const { samples, issues } = record({ path: 'electrical.batteries.*.voltage' }, sm)
    sm.publish('electrical.batteries.house bank.voltage', 'bmv', 12.6)
    sm.publish('electrical.batteries.house/bank.voltage', 'bmv', 12.5)
    expect(samples).toHaveLength(1)
    expect(issues).toHaveLength(1)
  })
})

describe('combinator signal', () => {
  const rpmDifference: Signal = {
    combinator: 'difference',
    inputs: [{ path: 'propulsion.port.revolutions' }, { path: 'propulsion.starboard.revolutions' }]
  }

  it('emits nothing until every input has been seen', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record(rpmDifference, sm)
    sm.publish('propulsion.port.revolutions', 'n2k.1', 30)
    expect(samples).toEqual([])
  })

  it('difference of port and starboard RPM emits on either input update', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record(rpmDifference, sm)
    sm.publish('propulsion.port.revolutions', 'n2k.1', 30)
    sm.publish('propulsion.starboard.revolutions', 'n2k.2', 28)
    sm.publish('propulsion.port.revolutions', 'n2k.1', 31)
    sm.publish('propulsion.starboard.revolutions', 'n2k.2', 32)
    expect(readings(samples)).toEqual([value(2), value(3), value(-1)])
    expect(samples.every((s) => s.instance === undefined && !s.replayed)).toBe(true)
  })

  it('an unavailable input makes the combination unavailable, and it recovers', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record(rpmDifference, sm)
    sm.publish('propulsion.port.revolutions', 'n2k.1', 30)
    sm.publish('propulsion.starboard.revolutions', 'n2k.2', 28)
    sm.timeOut('propulsion.starboard.revolutions', 'n2k.2')
    sm.publish('propulsion.port.revolutions', 'n2k.1', 31)
    sm.publish('propulsion.starboard.revolutions', 'n2k.2', 30)
    expect(readings(samples)).toEqual([
      value(2),
      { available: false, timedOut: true },
      { available: false, timedOut: true },
      value(1)
    ])
  })

  it('angle difference of two compasses wraps (359° vs 1° gives 2°)', () => {
    const sm = new FakeSubscriptionManager(['compass.a', 'compass.b'])
    const { samples } = record(
      {
        combinator: 'absDifference',
        angular: true,
        inputs: [
          { path: 'navigation.headingMagnetic', source: 'compass.a' },
          { path: 'navigation.headingMagnetic', source: 'compass.b' }
        ]
      },
      sm
    )
    sm.publish('navigation.headingMagnetic', 'compass.a', 359 * DEG)
    sm.publish('navigation.headingMagnetic', 'compass.b', 1 * DEG)
    const last = samples.at(-1)?.reading
    expect(last?.available && last.value).toBeCloseTo(2 * DEG)
  })

  it('position spread of three GNSS sources ranked below the preferred one', () => {
    const sm = new FakeSubscriptionManager(['gnss.mast', 'gnss.bow', 'gnss.stern'])
    const { samples } = record(
      {
        combinator: 'positionSpread',
        inputs: [
          { path: 'navigation.position', source: 'gnss.bow' },
          { path: 'navigation.position', source: 'gnss.stern' },
          { path: 'navigation.position', source: 'gnss.mast' }
        ]
      },
      sm
    )
    sm.publish('navigation.position', 'gnss.mast', { latitude: 60, longitude: 25 })
    sm.publish('navigation.position', 'gnss.bow', { latitude: 60.0001, longitude: 25 })
    sm.publish('navigation.position', 'gnss.stern', { latitude: 60.0005, longitude: 25 })
    const last = samples.at(-1)?.reading
    // 0.0005° of latitude on the mean-radius sphere.
    expect(last?.available && last.value).toBeCloseTo((6371008.8 * 0.0005 * Math.PI) / 180, 3)
  })

  it('ratio with a zero denominator yields unavailable, not infinity', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record(
      {
        combinator: 'ratio',
        inputs: [{ path: 'electrical.solar.current' }, { path: 'electrical.solar.maxCurrent' }]
      },
      sm
    )
    sm.publish('electrical.solar.current', 'mppt', 3)
    sm.publish('electrical.solar.maxCurrent', 'mppt', 0)
    expect(readings(samples)).toEqual([{ available: false, timedOut: false }])
  })

  it('is marked replayed when the combination is completed by the bootstrap', () => {
    const sm = new FakeSubscriptionManager()
    sm.publish('propulsion.port.revolutions', 'n2k.1', 30)
    sm.publish('propulsion.starboard.revolutions', 'n2k.2', 28)
    const { samples } = record(rpmDifference, sm)
    expect(samples).toEqual([{ reading: value(2), replayed: true }])
  })
})

describe('closing a signal', () => {
  it('ends every subscription it opened', () => {
    const sm = new FakeSubscriptionManager()
    const { samples, close } = record(
      {
        combinator: 'mean',
        inputs: [{ path: 'a.b' }, { path: 'a.c' }, { path: 'a.d' }]
      },
      sm
    )
    expect(sm.activeSubscriptions).toBe(3)
    close()
    expect(sm.activeSubscriptions).toBe(0)
    sm.publish('a.b', 's', 1)
    expect(samples).toEqual([])
  })
})

describe('field of an object path', () => {
  const ATTITUDE = 'navigation.attitude'
  const ROLL = 'navigation.attitude#/roll'
  const UNAVAILABLE = { available: false, timedOut: false }

  it("reads the field from the base path's value", () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record({ path: ROLL }, sm)
    sm.publish(ATTITUDE, 'imu', { roll: 0.4, pitch: 0, yaw: 0 })
    sm.publish(ATTITUDE, 'imu', { roll: 0.1, pitch: 0, yaw: 0 })
    expect(readings(samples)).toEqual([value(0.4), value(0.1)])
    expect(samples[0]?.instance).toBeUndefined()
  })

  it('reads a nested field', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record({ path: 'a.b#/c/d' }, sm)
    sm.publish('a.b', 'x', { c: { d: 'on' } })
    expect(readings(samples)).toEqual([value('on')])
  })

  it('a value without the field, or with a field of no readable shape, is unavailable', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record({ path: ROLL }, sm)
    sm.publish(ATTITUDE, 'imu', { pitch: 0, yaw: 0 })
    sm.publish(ATTITUDE, 'imu', { roll: [1], pitch: 0 })
    sm.publish(ATTITUDE, 'imu', 0.4)
    expect(readings(samples)).toEqual([UNAVAILABLE, UNAVAILABLE, UNAVAILABLE])
  })

  it("a null value is unavailable, timed out when the server's marker says so", () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record({ path: ROLL }, sm)
    sm.publish(ATTITUDE, 'imu', null)
    sm.timeOut(ATTITUDE, 'imu')
    sm.publish(ATTITUDE, 'imu', { roll: null })
    expect(readings(samples)).toEqual([
      UNAVAILABLE,
      { available: false, timedOut: true },
      UNAVAILABLE
    ])
  })

  it('a field that is itself a position reads as a position', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record({ path: 'navigation.anchor#/position' }, sm)
    sm.publish('navigation.anchor', 'gnss', { position: { latitude: 60, longitude: 25 } })
    expect(readings(samples)).toEqual([value({ latitude: 60, longitude: 25 })])
  })

  it('reads inherited object members as unavailable', () => {
    const sm = new FakeSubscriptionManager()
    const proto = record({ path: 'navigation.attitude#/__proto__' }, sm)
    const ctor = record({ path: 'navigation.attitude#/constructor' }, sm)
    sm.publish(ATTITUDE, 'imu', { roll: 0.4 })
    expect(readings(proto.samples)).toEqual([UNAVAILABLE])
    expect(readings(ctor.samples)).toEqual([UNAVAILABLE])
  })

  it('a pinned source ignores the field from another source', () => {
    const sm = new FakeSubscriptionManager(['imu.a', 'imu.b'])
    const { samples } = record({ path: ROLL, source: 'imu.b' }, sm)
    sm.publish(ATTITUDE, 'imu.a', { roll: 0.1 })
    sm.publish(ATTITUDE, 'imu.b', { roll: 0.2 })
    expect(readings(samples)).toEqual([value(0.2)])
  })

  it('a wildcard in the base path reads the field per instance', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record({ path: 'propulsion.*.drive#/trim' }, sm)
    sm.publish('propulsion.port.drive', 'n2k', { trim: 0.1 })
    sm.publish('propulsion.port.other.drive', 'n2k', { trim: 0.5 })
    sm.publish('propulsion.starboard.drive', 'n2k', { trim: 0.2 })
    expect(samples).toEqual([
      { instance: { name: 'port', segment: 'port' }, reading: value(0.1), replayed: false },
      {
        instance: { name: 'starboard', segment: 'starboard' },
        reading: value(0.2),
        replayed: false
      }
    ])
  })

  it('a wildcard directly before the pointer reads the field per instance', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record({ path: 'electrical.batteries.*#/voltage' }, sm)
    sm.publish('electrical.batteries.house', 'bmv', { voltage: 12.6 })
    expect(samples).toEqual([
      { instance: { name: 'house', segment: 'house' }, reading: value(12.6), replayed: false }
    ])
  })

  it('combines two fields of one object path', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record(
      {
        combinator: 'difference',
        inputs: [{ path: ROLL }, { path: 'navigation.attitude#/pitch' }]
      },
      sm
    )
    sm.publish(ATTITUDE, 'imu', { roll: 0.5, pitch: 0.25 })
    expect(readings(samples).at(-1)).toEqual(value(0.25))
  })

  it('combines both fields of each delta at once, never one field with the previous other', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record(
      {
        combinator: 'difference',
        inputs: [{ path: ROLL }, { path: 'navigation.attitude#/pitch' }]
      },
      sm
    )
    sm.publish(ATTITUDE, 'imu', { roll: 0.5, pitch: 0.25 })
    sm.publish(ATTITUDE, 'imu', { roll: 1, pitch: 0.5 })
    expect(readings(samples)).toEqual([value(0.25), value(0.5)])
  })

  it('fields of one path pinned to different sources stay apart', () => {
    const sm = new FakeSubscriptionManager()
    const { samples } = record(
      {
        combinator: 'difference',
        inputs: [
          { path: ROLL, source: 'imu.a' },
          { path: ROLL, source: 'imu.b' }
        ]
      },
      sm
    )
    sm.publish(ATTITUDE, 'imu.a', { roll: 0.5 })
    sm.publish(ATTITUDE, 'imu.b', { roll: 0.25 })
    expect(readings(samples)).toEqual([value(0.25)])
  })
})

describe('bindPath', () => {
  const house = { name: 'house', segment: 'house' }

  it('puts the instance in place of the wildcard of a field path', () => {
    expect(bindPath('electrical.batteries.*#/voltage', house)).toBe(
      'electrical.batteries.house#/voltage'
    )
    expect(bindPath('propulsion.*.drive#/trim', house)).toBe('propulsion.house.drive#/trim')
  })
})
