// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useAllInstances } from '../../../src/panel/editor/SignalFields'
import type { PathList } from '../../../src/panel/paths/selfPaths'
import { displayUnit } from '../../../src/panel/units'

const paths: PathList = {
  status: 'ready',
  paths: [
    { path: 'electrical.batteries.house#/voltage', unit: displayUnit({}) },
    { path: 'electrical.batteries.start#/voltage', unit: displayUnit({}) }
  ]
}

describe('useAllInstances on a field path', () => {
  it('turns a wildcard directly before the pointer on and back off', () => {
    const onChange = vi.fn()
    const slot = { path: 'electrical.batteries.house#/voltage', source: '' }
    const { result, rerender } = renderHook(
      ({ path }) => useAllInstances({ ...slot, path }, paths, onChange),
      { initialProps: { path: slot.path } }
    )
    expect(result.current).toMatchObject({
      checked: false,
      available: true,
      hint: 'Matches electrical.batteries.*#/voltage, one alert per instance.'
    })
    act(() => {
      result.current.toggle(true)
    })
    expect(onChange).toHaveBeenLastCalledWith({ ...slot, path: 'electrical.batteries.*#/voltage' })
    rerender({ path: 'electrical.batteries.*#/voltage' })
    expect(result.current).toMatchObject({ checked: true, hint: 'Matches now: house, start' })
    act(() => {
      result.current.toggle(false)
    })
    expect(onChange).toHaveBeenLastCalledWith(slot)
  })

  it('offers no toggle for a field outside the groups with instances', () => {
    const { result } = renderHook(() =>
      useAllInstances({ path: 'navigation.attitude#/roll', source: '' }, paths, vi.fn())
    )
    expect(result.current.available).toBe(false)
  })
})
