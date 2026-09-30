// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PathPicker } from '../../../src/panel/paths/PathPicker'
import type { PathEntry, PathList } from '../../../src/panel/paths/selfPaths'
import { displayUnit } from '../../../src/panel/units'

const paths: PathEntry[] = [
  {
    path: 'electrical.batteries.house.voltage',
    displayName: 'House battery',
    units: 'V',
    unit: displayUnit({ units: 'V', displayUnits: { formula: 'value * 1', symbol: 'V' } })
  },
  { path: 'navigation.state', unit: displayUnit({}) },
  {
    path: 'propulsion.port.coolantTemperature',
    displayName: 'Port coolant',
    units: 'K',
    unit: displayUnit({ units: 'K', displayUnits: { formula: 'value - 273.15', symbol: '°C' } })
  },
  { path: 'propulsion.port.revolutions', units: 'Hz', unit: displayUnit({ units: 'Hz' }) }
]

const ready: PathList = { status: 'ready', paths }

function Harness({
  list = ready,
  onChange
}: {
  list?: PathList
  onChange?: (path: string) => void
}) {
  const [value, setValue] = useState('')
  return (
    <PathPicker
      label="Input path"
      value={value}
      paths={list}
      onChange={(path) => {
        setValue(path)
        onChange?.(path)
      }}
    />
  )
}

beforeAll(() => {
  // jsdom does no layout, so it has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(cleanup)

const input = () => screen.getByRole('combobox', { name: 'Input path' })
const optionNames = () => screen.queryAllByRole('option').map((o) => o.getAttribute('data-path'))

describe('PathPicker', () => {
  it('is a labelled, collapsed combobox that controls a listbox', () => {
    render(<Harness />)
    expect(input()).toHaveProperty('value', '')
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(input().getAttribute('aria-autocomplete')).toBe('list')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('opens on ArrowDown with the first option active', () => {
    render(<Harness />)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(input().getAttribute('aria-expanded')).toBe('true')
    const listbox = screen.getByRole('listbox')
    expect(input().getAttribute('aria-controls')).toBe(listbox.id)
    const first = within(listbox).getAllByRole('option')[0]
    expect(input().getAttribute('aria-activedescendant')).toBe(first.id)
    expect(first.getAttribute('aria-selected')).toBe('true')
  })

  it('moves the active option with the arrow keys, wrapping at the ends', () => {
    render(<Harness />)
    const active = () =>
      document.getElementById(input().getAttribute('aria-activedescendant') ?? '')?.dataset.path
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(active()).toBe('navigation.state')
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(active()).toBe('propulsion.port.revolutions')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(active()).toBe('electrical.batteries.house.voltage')
  })

  it('selects the active option with Enter and closes', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith('propulsion.port.coolantTemperature')
    expect(input()).toHaveProperty('value', 'propulsion.port.coolantTemperature')
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(input().hasAttribute('aria-activedescendant')).toBe(false)
  })

  it('leaves Enter alone when no option is active, so a form can submit', () => {
    render(<Harness />)
    const notCancelled = fireEvent.keyDown(input(), { key: 'Enter' })
    expect(notCancelled).toBe(true)
  })

  it('closes on Escape without changing the value', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('filters as the user types, by path or display name, every word matching', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.change(input(), { target: { value: 'PORT' } })
    expect(onChange).toHaveBeenLastCalledWith('PORT')
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(input().hasAttribute('aria-activedescendant')).toBe(false)
    expect(optionNames()).toEqual([
      'propulsion.port.coolantTemperature',
      'propulsion.port.revolutions'
    ])
    fireEvent.change(input(), { target: { value: 'house batt' } })
    expect(optionNames()).toEqual(['electrical.batteries.house.voltage'])
    fireEvent.change(input(), { target: { value: 'coolant port' } })
    expect(optionNames()).toEqual(['propulsion.port.coolantTemperature'])
  })

  it('keeps a typed path no option matches, for paths not reported yet', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.change(input(), { target: { value: 'tanks.fuel.main.currentLevel' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText(/no reported path matches/i)).toBeTruthy()
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(input()).toHaveProperty('value', 'tanks.fuel.main.currentLevel')
  })

  it('shows each option with its display name and unit', () => {
    render(<Harness />)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    const coolant = screen.getByRole('option', { name: /propulsion\.port\.coolantTemperature/ })
    expect(coolant.textContent).toContain('Port coolant')
    expect(coolant.textContent).toContain('°C')
    const revolutions = screen.getByRole('option', { name: /revolutions/ })
    expect(revolutions.textContent).toContain('Hz (SI)')
    const state = screen.getByRole('option', { name: /navigation\.state/ })
    expect(state.textContent).not.toContain('SI')
  })

  it('selects an option clicked with the pointer', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.click(screen.getByRole('option', { name: /navigation\.state/ }))
    expect(onChange).toHaveBeenLastCalledWith('navigation.state')
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('closes when focus leaves', () => {
    render(<Harness />)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.blur(input())
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('says the paths are loading, and still accepts a typed path', () => {
    const onChange = vi.fn()
    render(<Harness list={{ status: 'loading' }} onChange={onChange} />)
    expect(screen.getByText(/loading paths/i)).toBeTruthy()
    fireEvent.change(input(), { target: { value: 'navigation.log' } })
    expect(onChange).toHaveBeenLastCalledWith('navigation.log')
  })

  it('is expanded, and names its listbox, only while the listbox is shown', () => {
    render(<Harness />)
    expect(input().hasAttribute('aria-controls')).toBe(false)
    fireEvent.change(input(), { target: { value: 'tanks.fuel.main.currentLevel' } })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(input().hasAttribute('aria-controls')).toBe(false)
  })

  it('announces the match count, no match and loading in one status it is described by', () => {
    const { rerender } = render(<Harness />)
    const status = () => {
      const node = screen.getByRole('status')
      expect(input().getAttribute('aria-describedby')).toBe(node.id)
      return node.textContent
    }
    fireEvent.change(input(), { target: { value: 'port' } })
    expect(status()).toMatch(/2 paths match/i)
    fireEvent.change(input(), { target: { value: 'tanks.fuel.main.currentLevel' } })
    expect(status()).toMatch(/no reported path matches/i)
    rerender(<Harness list={{ status: 'loading' }} />)
    expect(status()).toMatch(/loading paths/i)
  })

  it('says why the paths could not be loaded', () => {
    render(<Harness list={{ status: 'failed', error: 'answered 500' }} />)
    expect(screen.getByText(/could not load paths: answered 500/i)).toBeTruthy()
  })
})
