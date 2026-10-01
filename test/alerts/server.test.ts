import { describe, it, expect } from 'vitest'
import type { ServerAPI } from '@signalk/server-api'
import { serverDeps } from '../../src/alerts/server.js'

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
})
