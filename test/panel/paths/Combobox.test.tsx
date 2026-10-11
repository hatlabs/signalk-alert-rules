// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  Combobox,
  type ComboboxOption,
  type ComboboxSource
} from '../../../src/panel/paths/Combobox'

const engines: ComboboxOption[] = [
  { value: 'main', primary: 'main', secondary: 'Main engine', trailing: '0 rpm' },
  { value: 'port', primary: 'port', trailing: '1200 rpm' },
  { value: 'starboard', primary: 'starboard', trailing: '1200 rpm' }
]

const ready: ComboboxSource<ComboboxOption> = { status: 'ready', options: engines }

const startsWith = (option: ComboboxOption, query: string) =>
  option.value.startsWith(query.toLowerCase())

function Harness({
  initial = '',
  source = ready,
  opener = true,
  progressStatus,
  onCommit
}: {
  initial?: string
  source?: ComboboxSource<ComboboxOption>
  opener?: boolean
  progressStatus?: boolean
  onCommit?: (value: string) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <button type="button">Before</button>
      <Combobox
        label="Engine"
        value={value}
        source={source}
        filter={startsWith}
        matchStatus={(n) => (n === 0 ? 'Nothing reports an engine' : `${String(n)} engines`)}
        onChange={setValue}
        opener={opener}
        {...(progressStatus === undefined ? {} : { progressStatus })}
        {...(onCommit === undefined ? {} : { onCommit })}
      />
    </>
  )
}

beforeAll(() => {
  // jsdom does no layout, so it has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(cleanup)

const input = () => screen.getByRole('combobox', { name: 'Engine' })
const chevron = () => screen.getByRole('button', { name: 'Engine' })
const listed = () => screen.queryAllByRole('option').map((o) => o.textContent)
const active = () => document.getElementById(input().getAttribute('aria-activedescendant') ?? '')

describe('Combobox with the opener', () => {
  it('opens on a click in the input, listing every option', () => {
    render(<Harness />)
    fireEvent.click(input())
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(listed()).toEqual(['mainMain engine0 rpm', 'port1200 rpm', 'starboard1200 rpm'])
    expect(input().hasAttribute('aria-activedescendant')).toBe(false)
  })

  it('opens on a chevron click and closes on a second one', () => {
    render(<Harness />)
    fireEvent.click(chevron())
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(chevron().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('option')).toHaveLength(3)
    fireEvent.click(chevron())
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(chevron().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('keeps the chevron out of the tab order and moves focus to the input', () => {
    render(<Harness />)
    expect(chevron().tabIndex).toBe(-1)
    fireEvent.click(chevron())
    expect(document.activeElement).toBe(input())
  })

  it('reopened on a value lists every option, that one selected and active', () => {
    render(<Harness initial="port" />)
    fireEvent.click(chevron())
    expect(screen.getAllByRole('option')).toHaveLength(3)
    const port = screen.getByRole('option', { name: /port/ })
    expect(port.getAttribute('aria-selected')).toBe('true')
    expect(active()).toBe(port)
  })

  it('filters from the first keystroke after opening', () => {
    render(<Harness initial="port" />)
    fireEvent.click(input())
    expect(screen.getAllByRole('option')).toHaveLength(3)
    fireEvent.change(input(), { target: { value: 's' } })
    expect(listed()).toEqual(['starboard1200 rpm'])
    expect(screen.getByRole('status').textContent).toBe('1 engines')
  })

  it('opens on ArrowDown with every option, the current one active', () => {
    render(<Harness initial="starboard" />)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(active()?.textContent).toBe('starboard1200 rpm')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(active()?.textContent).toBe('mainMain engine0 rpm')
  })

  it('opens on ArrowDown on a value no option holds with the first option active', () => {
    render(<Harness initial="aft" />)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(active()?.textContent).toBe('mainMain engine0 rpm')
  })

  it('stays closed when Tab brings focus into the field', () => {
    render(<Harness initial="port" />)
    screen.getByRole('button', { name: 'Before' }).focus()
    input().focus()
    expect(document.activeElement).toBe(input())
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('picks the active option on Enter and commits it', () => {
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    fireEvent.click(input())
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(input()).toHaveProperty('value', 'port')
    expect(onCommit).toHaveBeenLastCalledWith('port')
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('commits a clicked option', () => {
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    fireEvent.click(chevron())
    fireEvent.click(screen.getByRole('option', { name: /starboard/ }))
    expect(input()).toHaveProperty('value', 'starboard')
    expect(onCommit).toHaveBeenCalledOnce()
    expect(onCommit).toHaveBeenLastCalledWith('starboard')
  })

  it('closes on Escape without changing the value', () => {
    render(<Harness initial="port" />)
    fireEvent.click(input())
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(input()).toHaveProperty('value', 'port')
  })

  it('opens to its no-match status when there are no options', () => {
    render(<Harness source={{ status: 'ready', options: [] }} />)
    fireEvent.click(chevron())
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Nothing reports an engine')
  })

  it('shows loading and failure by default', () => {
    const { rerender } = render(<Harness source={{ status: 'loading', message: 'Loading…' }} />)
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    rerender(<Harness source={{ status: 'failed', message: 'Could not load' }} />)
    expect(screen.getByRole('status').textContent).toBe('Could not load')
  })

  it('with its progress status suppressed, says nothing while loading or failed', () => {
    const { rerender } = render(
      <Harness source={{ status: 'loading', message: 'Loading…' }} progressStatus={false} />
    )
    expect(screen.getByRole('status').textContent).toBe('')
    fireEvent.click(chevron())
    expect(screen.getByRole('status').textContent).toBe('')
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.change(input(), { target: { value: 'aft' } })
    expect(input()).toHaveProperty('value', 'aft')
    rerender(
      <Harness source={{ status: 'failed', message: 'Could not load' }} progressStatus={false} />
    )
    expect(screen.getByRole('status').textContent).toBe('')
  })
})

describe('Combobox texts', () => {
  const statusOf = (n: number, filtered: boolean) =>
    filtered ? `${String(n)} match` : `${String(n)} listed`

  it('shows its placeholder in the empty input', () => {
    render(
      <Combobox
        label="Engine"
        value=""
        source={ready}
        filter={startsWith}
        matchStatus={statusOf}
        onChange={vi.fn()}
        placeholder="Choose or type an engine"
      />
    )
    expect(input().getAttribute('placeholder')).toBe('Choose or type an engine')
  })

  it('tells the status whether the list is filtered', () => {
    render(<Harness />)
    fireEvent.click(input())
    expect(screen.getByRole('status').textContent).toBe('3 engines')
    cleanup()
    function Counting() {
      const [value, setValue] = useState('')
      return (
        <Combobox
          label="Engine"
          value={value}
          source={ready}
          filter={startsWith}
          matchStatus={statusOf}
          onChange={setValue}
          opener
        />
      )
    }
    render(<Counting />)
    fireEvent.click(input())
    expect(screen.getByRole('status').textContent).toBe('3 listed')
    fireEvent.change(input(), { target: { value: 'p' } })
    expect(screen.getByRole('status').textContent).toBe('1 match')
  })

  it('shows its context between the label and the input, as part of the description', () => {
    render(
      <Combobox
        label="Engine"
        value=""
        source={ready}
        filter={startsWith}
        matchStatus={statusOf}
        onChange={vi.fn()}
        context="propulsion.<engine>.revolutions"
        hint="Not reporting"
      />
    )
    const described = (input().getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
    expect(described).toEqual(['propulsion.<engine>.revolutions', 'Not reporting', ''])
    const label = screen.getByText('Engine', { selector: 'label' })
    const context = screen.getByText('propulsion.<engine>.revolutions')
    expect(label.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(context.compareDocumentPosition(input()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('stacks an option’s primary above its secondary, the trailing text on one line', () => {
    const stacked: ComboboxOption[] = [
      {
        value: 'house',
        primary: 'House battery',
        secondary: 'electrical.batteries.house',
        trailing: '13.3 V'
      },
      { value: 'start', primary: '', secondary: 'electrical.batteries.start', trailing: '12.6 V' }
    ]
    render(
      <Combobox
        label="Battery"
        value=""
        source={{ status: 'ready', options: stacked }}
        filter={startsWith}
        matchStatus={statusOf}
        onChange={vi.fn()}
        optionLayout="stacked"
        opener
      />
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Battery' }))
    const [house, start] = screen.getAllByRole('option')
    expect(house.classList).toContain('skar-combo-option-stacked')
    const main = house.querySelector('.skar-combo-option-main')
    expect([...(main?.children ?? [])].map((c) => [c.className, c.textContent])).toEqual([
      ['skar-combo-option-name', 'House battery'],
      ['skar-combo-option-detail', 'electrical.batteries.house']
    ])
    expect(house.lastElementChild?.textContent).toBe('13.3 V')
    expect(start.querySelector('.skar-combo-option-name')).toBeNull()
    expect(start.textContent).toBe('electrical.batteries.start12.6 V')
  })
})

describe('Combobox without the opener', () => {
  it('has no chevron and does not open on a click', () => {
    render(<Harness opener={false} initial="port" />)
    expect(screen.queryByRole('button', { name: 'Engine' })).toBeNull()
    fireEvent.click(input())
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('opens on ArrowDown to the options its text matches', () => {
    render(<Harness opener={false} initial="port" />)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    const listbox = screen.getByRole('listbox')
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['port1200 rpm'])
  })
})
