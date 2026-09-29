import { describe, it, expect } from 'vitest'
import { InstanceRegistry, instanceIn, instanceSegment } from '../../src/engine/instances.js'
import { MAX_INSTANCES } from '../../src/model/rule.js'

describe('instanceIn', () => {
  it('returns the segment the wildcard stands for', () => {
    expect(instanceIn('propulsion.*.revolutions', 'propulsion.port.revolutions')).toBe('port')
  })

  it('matches a wildcard in the first or last segment', () => {
    expect(instanceIn('*.voltage', 'house.voltage')).toBe('house')
    expect(instanceIn('tanks.fuel.*', 'tanks.fuel.0')).toBe('0')
  })

  it('does not let the wildcard span several segments', () => {
    expect(instanceIn('propulsion.*.revolutions', 'propulsion.a.b.revolutions')).toBeUndefined()
  })

  it('does not match a path whose fixed segments differ', () => {
    expect(instanceIn('propulsion.*.revolutions', 'propulsion.port.temperature')).toBeUndefined()
    expect(instanceIn('propulsion.*.revolutions', 'propulsion.port.revolutions.x')).toBeUndefined()
  })
})

describe('instanceSegment', () => {
  it('keeps a name that is already a valid alert path segment', () => {
    expect(instanceSegment('port_1-a')).toBe('port_1-a')
  })

  it('replaces characters an alert path segment cannot hold', () => {
    expect(instanceSegment('house bank #2')).toBe('house_bank__2')
  })
})

describe('InstanceRegistry', () => {
  it('admits a name and returns its alert path segment', () => {
    const registry = new InstanceRegistry()
    expect(registry.admit('house bank')).toEqual({ ok: true, segment: 'house_bank' })
  })

  it('admits the same name again with the same result', () => {
    const registry = new InstanceRegistry()
    registry.admit('port')
    expect(registry.admit('port')).toEqual({ ok: true, segment: 'port' })
  })

  it('rejects a name whose segment collides with an admitted one', () => {
    const registry = new InstanceRegistry()
    registry.admit('house bank')
    const result = registry.admit('house/bank')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/house bank/)
  })

  it(`rejects names beyond ${String(MAX_INSTANCES)} instances`, () => {
    const registry = new InstanceRegistry()
    for (let i = 0; i < MAX_INSTANCES; i++) expect(registry.admit(`i${String(i)}`).ok).toBe(true)
    const result = registry.admit('one-too-many')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(String(MAX_INSTANCES))
    expect(registry.admit('i0').ok).toBe(true)
  })
})
