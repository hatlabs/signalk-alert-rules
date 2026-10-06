import { describe, it, expect } from 'vitest'
import type { ServerAPI } from '@signalk/server-api'
import { signalUnits } from '../../src/alerts/messageUnits.js'
import { serverDeps } from '../../src/alerts/server.js'
import { RuleEvaluator } from '../../src/engine/evaluator.js'
import { validateRule } from '../../src/model/validate.js'
import { FakeSubscriptionManager } from '../helpers/FakeSubscriptionManager.js'

interface Handled {
  id: string
  delta: unknown
}

function app(extra: Record<string, unknown> = {}) {
  const handled: Handled[] = []
  const selfPaths: Record<string, unknown> = {
    'electrical.batteries.house.voltage.meta': { zones: [{ upper: 11.5, state: 'alarm' }] }
  }
  const alert = {
    id: 'a1',
    path: 'rules.x',
    $source: 'signalk-alert-rules',
    priority: 'alarm',
    message: 'm',
    latching: false,
    condition: true,
    state: 'unacknowledged',
    stale: false,
    raisedAt: '2026-09-29T00:00:00Z'
  }
  const fake = {
    subscriptionmanager: {},
    getSelfPath: (path: string) => selfPaths[path],
    getMetadata: () => undefined,
    handleMessage: (id: string, delta: unknown) => handled.push({ id, delta }),
    alerts: {
      list: () => [alert]
    },
    ...extra
  }
  return { app: fake as unknown as ServerAPI, handled }
}

describe('server adapter', () => {
  it('emits alert deltas under the alerts prefix as the plugin', () => {
    const { app: a, handled } = app()
    const deps = serverDeps(a, 'signalk-alert-rules')
    deps.send('rules.x', { priority: 'alarm', message: 'm', latching: false })
    deps.send('rules.x', null)
    expect(handled).toEqual([
      {
        id: 'signalk-alert-rules',
        delta: {
          updates: [
            {
              values: [
                {
                  path: 'alerts.rules.x',
                  value: { priority: 'alarm', message: 'm', latching: false }
                }
              ]
            }
          ]
        }
      },
      {
        id: 'signalk-alert-rules',
        delta: { updates: [{ values: [{ path: 'alerts.rules.x', value: null }] }] }
      }
    ])
  })

  it('reads alerts and path meta', () => {
    const deps = serverDeps(app().app, 'signalk-alert-rules')
    expect(deps.alerts.list()).toEqual([expect.objectContaining({ condition: true })])
    expect(deps.meta('electrical.batteries.house.voltage')?.zones).toHaveLength(1)
    expect(deps.meta('nowhere')).toBeUndefined()
  })

  it('reads the data-timeout settings best effort', () => {
    const on = serverDeps(app({ config: { settings: { enforceDataTimeouts: true } } }).app, 'p')
    expect(on.timeoutSettings()).toEqual({ enforce: true, useDefaults: true })
    const off = serverDeps(
      app({ config: { settings: { enforceDataTimeouts: false, useDefaultTimeouts: false } } }).app,
      'p'
    )
    expect(off.timeoutSettings()).toEqual({ enforce: false, useDefaults: false })
    expect(serverDeps(app().app, 'p').timeoutSettings()).toBeUndefined()
  })

  it('treats meta that is not an object as missing', () => {
    const deps = serverDeps(app({ getSelfPath: () => 'not meta' }).app, 'p')
    expect(deps.meta('x')).toBeUndefined()
  })

  it('reads the units of a path', () => {
    const deps = serverDeps(app({ getSelfPath: () => ({ units: 'rad' }) }).app, 'p')
    expect(deps.meta('x')?.units).toBe('rad')
  })

  // The data tree's meta holds what was set for the path, not the units the
  // specification gives it; the server's metadata lookup has those.
  it("falls back to the specification's units, which the data tree's meta leaves out", () => {
    const spec: Record<string, unknown> = {
      'vessels.self.electrical.batteries.house.voltage': { units: 'V' },
      'vessels.self.environment.depth.belowKeel': { units: 'm' },
      'vessels.self.x': { units: 'K' }
    }
    const deps = serverDeps(app({ getMetadata: (path: string) => spec[path] }).app, 'p')
    expect(deps.meta('electrical.batteries.house.voltage')).toMatchObject({
      units: 'V',
      zones: [{ upper: 11.5, state: 'alarm' }]
    })
    expect(deps.meta('environment.depth.belowKeel')?.units).toBe('m')
    expect(deps.meta('nowhere')).toBeUndefined()
    const set = serverDeps(
      app({ getSelfPath: () => ({ units: 'C' }), getMetadata: (path: string) => spec[path] }).app,
      'p'
    )
    expect(set.meta('x')?.units).toBe('C')
  })

  it('drops malformed zones and meta fields', () => {
    const deps = serverDeps(
      app({
        getSelfPath: () => ({
          zones: [{ upper: 11, state: 'alarm' }, { upper: 'high', state: 'warn' }, 'zone'],
          units: 1,
          timeout: {},
          updateContract: 5
        })
      }).app,
      'p'
    )
    expect(deps.meta('x')).toEqual({
      zones: [{ upper: 11, state: 'alarm' }],
      units: undefined,
      timeout: undefined,
      updateContract: undefined
    })
  })

  describe('of a field of an object path', () => {
    // The shape of the server's built-in metadata for navigation.attitude.
    const attitudeSpec = {
      description: 'Vessel attitude: roll, pitch and yaw',
      properties: {
        roll: {
          type: 'number',
          description: 'Vessel roll, +ve is list to starboard',
          units: 'rad'
        },
        pitch: { type: 'number', units: 'rad' },
        yaw: { type: 'number', units: 'rad' }
      }
    }
    const spec: Record<string, unknown> = {
      'vessels.self.navigation.attitude': attitudeSpec,
      'vessels.self.electrical.batteries.house': {
        properties: { cell: { properties: { voltage: { type: 'number', units: 'V' } } } }
      }
    }
    const tree: Record<string, unknown> = {
      'navigation.attitude.meta': {
        timeout: 5,
        updateContract: 'periodic',
        zones: [{ upper: 1, state: 'alarm' }]
      }
    }
    const deps = serverDeps(
      app({
        getSelfPath: (path: string) => tree[path],
        getMetadata: (path: string) => spec[path]
      }).app,
      'p'
    )

    it("has the base path's timing, no zones, and the field's units from the base path's properties", () => {
      expect(deps.meta('navigation.attitude#/roll')).toEqual({
        zones: undefined,
        units: 'rad',
        timeout: 5,
        updateContract: 'periodic'
      })
    })

    it('walks nested properties, for an instance put in place of a wildcard', () => {
      expect(deps.meta('electrical.batteries.house#/cell/voltage')?.units).toBe('V')
    })

    it('has no units for a field the metadata does not describe, or an inherited member', () => {
      expect(deps.meta('navigation.attitude#/heel')).toMatchObject({ units: undefined, timeout: 5 })
      expect(deps.meta('navigation.attitude#/roll/x')?.units).toBeUndefined()
      expect(deps.meta('navigation.attitude#/__proto__')?.units).toBeUndefined()
      expect(deps.meta('navigation.attitude#/constructor')?.units).toBeUndefined()
      expect(deps.meta('nowhere#/x')).toBeUndefined()
    })

    it("prefers the units in the data tree's meta, as for a whole path", () => {
      const set = serverDeps(
        app({
          getSelfPath: () => ({ properties: { roll: { units: 'deg' } } }),
          getMetadata: (path: string) => spec[path]
        }).app,
        'p'
      )
      expect(set.meta('navigation.attitude#/roll')?.units).toBe('deg')
      expect(set.meta('navigation.attitude#/pitch')?.units).toBe('rad')
    })

    it("gives a field rule the base path's update contract and the field's units", () => {
      const sm = new FakeSubscriptionManager()
      const fieldApp = app({
        subscriptionmanager: sm,
        getSelfPath: () => ({ updateContract: 'event' }),
        getMetadata: (path: string) => spec[path]
      }).app
      const fieldDeps = serverDeps(fieldApp, 'p')
      const rule = validateRule({
        name: 'Attitude silent',
        slug: 'attitude-silent',
        message: 'Roll {value}',
        signal: { path: 'navigation.attitude#/roll' },
        detector: { type: 'match', op: 'timedOut', steps: [{ priority: 'warning' }], duration: 30 }
      })
      if (!rule.ok) throw new Error(JSON.stringify(rule.errors))
      const evaluator = new RuleEvaluator(
        rule.value,
        {
          subscriptions: sm,
          meta: fieldDeps.meta,
          timeoutSettings: () => ({ enforce: true, useDefaults: true }),
          clock: () => 0
        },
        () => undefined
      )
      evaluator.start()
      sm.publish('navigation.attitude', 'imu', { roll: 0.1 })
      expect(evaluator.status().instances[0]?.judgement.problem).toEqual({
        reason: 'timeoutNotPossible',
        cause: 'updateContract',
        contract: 'event'
      })
      expect(signalUnits(rule.value.signal, undefined, fieldDeps.meta)).toBe('rad')
    })
  })
})
