// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionExpiredError } from '../../../src/panel/api'
import {
  httpPathSource,
  parseSelfPaths,
  useSelfPaths,
  type PathSource
} from '../../../src/panel/paths/selfPaths'

/** A fetch that answers each URL with a JSON body and a status. */
function fakeFetch(routes: Partial<Record<string, { status?: number; body: unknown }>>) {
  return vi.fn<typeof fetch>((input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const route = routes[url]
    if (route === undefined) return Promise.resolve(new Response('{}', { status: 404 }))
    return Promise.resolve(
      new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
  })
}

const source = { label: 'n2k', type: 'NMEA2000' }

/** Part of `GET /signalk/v1/api/vessels/self` as signalk-server answers it. */
const selfTree = {
  name: 'Example',
  uuid: 'urn:mrn:signalk:uuid:00000000-0000-4000-8000-000000000000',
  propulsion: {
    port: {
      label: 'Port',
      coolantTemperature: {
        value: 355.2,
        $source: 'n2k.1',
        timestamp: '2026-09-30T12:00:00.000Z',
        meta: {
          units: 'K',
          displayName: 'Port coolant',
          description: 'Engine coolant temperature',
          displayUnits: {
            category: 'temperature',
            targetUnit: 'C',
            formula: 'value - 273.15',
            inverseFormula: 'value + 273.15',
            symbol: '°C'
          }
        },
        values: { 'n2k.1': { value: 355.2, timestamp: '2026-09-30T12:00:00.000Z' } }
      },
      revolutions: {
        value: 30,
        $source: 'n2k.1',
        timestamp: '2026-09-30T12:00:00.000Z',
        meta: { units: 'Hz' }
      }
    }
  },
  navigation: {
    position: {
      value: { latitude: 60.1, longitude: 24.9 },
      $source: 'gnss.bow',
      timestamp: '2026-09-30T12:00:00.000Z'
    },
    state: { value: 'motoring', $source: 'x', timestamp: '2026-09-30T12:00:00.000Z' },
    attitude: {
      value: { roll: 0, pitch: 0, yaw: 0 },
      $source: 'x',
      timestamp: '2026-09-30T12:00:00.000Z',
      meta: { units: 'rad' }
    }
  },
  electrical: {
    batteries: {
      house: {
        voltage: {
          value: null,
          $source: 'n2k.2',
          timestamp: '2026-09-30T12:00:00.000Z',
          meta: {
            units: 'V',
            displayUnits: { category: 'voltage', formula: 'value * 1', symbol: 'V' }
          }
        }
      }
    }
  },
  notifications: {
    mob: {
      value: { state: 'normal', method: [], message: '' },
      $source: 'x',
      timestamp: '2026-09-30T12:00:00.000Z'
    }
  },
  sources: { n2k: source }
}

describe('parseSelfPaths', () => {
  it('lists every path with a reading, sorted, with display name and unit from meta', () => {
    const paths = parseSelfPaths(selfTree)
    expect(paths.map((p) => p.path)).toEqual([
      'electrical.batteries.house.voltage',
      'navigation.position',
      'navigation.state',
      'propulsion.port.coolantTemperature',
      'propulsion.port.revolutions'
    ])
    const coolant = paths.find((p) => p.path === 'propulsion.port.coolantTemperature')
    expect(coolant).toMatchObject({
      displayName: 'Port coolant',
      description: 'Engine coolant temperature',
      units: 'K',
      unit: { symbol: '°C', si: false, scale: 1, offset: -273.15 }
    })
    expect(paths.find((p) => p.path === 'propulsion.port.revolutions')?.unit).toMatchObject({
      symbol: 'Hz',
      si: true
    })
    expect(paths.find((p) => p.path === 'navigation.state')?.units).toBeUndefined()
  })

  it('ignores malformed meta rather than failing the list', () => {
    const paths = parseSelfPaths({
      a: { value: 1, meta: { units: 3, displayName: {}, displayUnits: { formula: 4 } } }
    })
    expect(paths).toEqual([{ path: 'a', unit: { symbol: '', scale: 1, offset: 0, si: true } }])
  })

  it('rejects a body that is not a tree', () => {
    expect(() => parseSelfPaths([])).toThrow(/unexpected response/)
  })
})

describe('httpPathSource', () => {
  it('reads the self tree with the session cookie', async () => {
    const fetchFn = fakeFetch({ '/signalk/v1/api/vessels/self': { body: selfTree } })
    const paths = await httpPathSource(fetchFn).selfPaths()
    expect(paths).toHaveLength(5)
    expect(fetchFn.mock.calls[0]?.[1]?.credentials).toBe('same-origin')
  })

  it('reports an expired session when the server refuses the tree with 401', async () => {
    const fetchFn = fakeFetch({ '/signalk/v1/api/vessels/self': { status: 401, body: {} } })
    await expect(httpPathSource(fetchFn).selfPaths()).rejects.toBeInstanceOf(SessionExpiredError)
  })

  it("fails with the server's own message when it gives one", async () => {
    const fetchFn = fakeFetch({
      '/signalk/v1/api/vessels/self': { status: 500, body: { error: 'tree unavailable' } }
    })
    await expect(httpPathSource(fetchFn).selfPaths()).rejects.toThrow('tree unavailable')
  })

  it('fails with the status when the server refuses the tree', async () => {
    const fetchFn = fakeFetch({ '/signalk/v1/api/vessels/self': { status: 500, body: {} } })
    await expect(httpPathSource(fetchFn).selfPaths()).rejects.toThrow(/500/)
  })

  const definitions = {
    m: {
      conversions: {
        'naut-mile': { formula: 'value * 0.0005399568034557236', symbol: 'nmi' },
        kilometer: { formula: 'value * 0.001', symbol: 'km' }
      }
    }
  }
  const preset = (targetUnit: string) => ({
    name: 'p',
    categories: { distance: { baseUnit: 'm', targetUnit } }
  })

  it("resolves the distance unit from the user's own preset first", async () => {
    const fetchFn = fakeFetch({
      '/signalk/v1/applicationData/user/unitpreferences/1.0.0': {
        body: { activePreset: 'metric' }
      },
      '/signalk/v1/unitpreferences/config': { body: { activePreset: 'nautical-metric' } },
      '/signalk/v1/unitpreferences/presets/metric': { body: preset('kilometer') },
      '/signalk/v1/unitpreferences/presets/nautical-metric': { body: preset('naut-mile') },
      '/signalk/v1/unitpreferences/definitions': { body: definitions }
    })
    expect(await httpPathSource(fetchFn).distanceUnit()).toMatchObject({ symbol: 'km', si: false })
  })

  it("falls back to the server's preset when the user has none", async () => {
    const fetchFn = fakeFetch({
      '/signalk/v1/unitpreferences/config': { body: { activePreset: 'nautical-metric' } },
      '/signalk/v1/unitpreferences/presets/nautical-metric': { body: preset('naut-mile') },
      '/signalk/v1/unitpreferences/definitions': { body: definitions }
    })
    const unit = await httpPathSource(fetchFn).distanceUnit()
    expect(unit).toMatchObject({ symbol: 'nmi', si: false })
  })

  it('falls back to metres, labelled SI, when the preferences cannot be read', async () => {
    const unit = await httpPathSource(fakeFetch({})).distanceUnit()
    expect(unit).toEqual({ symbol: 'm', scale: 1, offset: 0, si: true })
  })

  it('falls back to metres when the preset names a unit with no conversion', async () => {
    const fetchFn = fakeFetch({
      '/signalk/v1/unitpreferences/config': { body: { activePreset: 'odd' } },
      '/signalk/v1/unitpreferences/presets/odd': { body: preset('furlong') },
      '/signalk/v1/unitpreferences/definitions': { body: definitions }
    })
    expect(await httpPathSource(fetchFn).distanceUnit()).toMatchObject({ symbol: 'm', si: true })
  })
})

describe('useSelfPaths', () => {
  const distanceUnit = () => Promise.resolve({ symbol: 'm', scale: 1, offset: 0, si: true })

  it('is loading until the paths arrive, then lists them', async () => {
    const source: PathSource = {
      selfPaths: () => Promise.resolve(parseSelfPaths(selfTree)),
      distanceUnit
    }
    const { result } = renderHook(() => useSelfPaths(source))
    expect(result.current).toEqual({ status: 'loading' })
    await waitFor(() => {
      expect(result.current.status).toBe('ready')
    })
  })

  it('reports why the paths could not be loaded', async () => {
    const source: PathSource = {
      selfPaths: () => Promise.reject(new Error('/signalk/v1/api/vessels/self answered 500')),
      distanceUnit
    }
    const { result } = renderHook(() => useSelfPaths(source))
    await waitFor(() => {
      expect(result.current).toEqual({
        status: 'failed',
        error: '/signalk/v1/api/vessels/self answered 500'
      })
    })
  })
})
