// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KindPicker } from '../../../src/panel/add/KindPicker'
import { PathSearch } from '../../../src/panel/add/PathSearch'
import type { PathSource } from '../../../src/panel/paths/selfPaths'
import { pathSource } from '../editor/editorFixtures'

const search = () => screen.getByRole('searchbox', { name: 'Search by name or path' })
const query = (text: string) => {
  fireEvent.change(search(), { target: { value: text } })
}

describe('PathSearch', () => {
  afterEach(cleanup)

  function renderSearch(paths: PathSource = pathSource) {
    render(<PathSearch paths={paths} backHref="#add" pathHref={(p) => `#to=${p}`} />)
  }

  it('finds a value by words of its display name in any order, with its value now', async () => {
    renderSearch()
    await screen.findByRole('list', { name: 'Values' })
    query('bow thruster volt')
    const rows = screen
      .getAllByRole('link')
      .filter((l) => l.getAttribute('href')?.startsWith('#to='))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('Bow thruster battery voltage')
    expect(rows[0]?.textContent).toContain('electrical.batteries.bowThruster.voltage')
    expect(rows[0]?.textContent).toContain('12.9 V')
    expect(rows[0]?.getAttribute('href')).toBe('#to=electrical.batteries.bowThruster.voltage')
  })

  it('says when nothing matches', async () => {
    renderSearch()
    await screen.findByRole('list', { name: 'Values' })
    query('windlass')
    expect(screen.getByText('No reported value matches.')).toBeTruthy()
  })

  it('offers a full path no value reports yet as typed', async () => {
    renderSearch()
    await screen.findByRole('list', { name: 'Values' })
    query('electrical.batteries.aux.voltage')
    expect(screen.getByRole('link', { name: /Use the path as typed/ }).getAttribute('href')).toBe(
      '#to=electrical.batteries.aux.voltage'
    )
  })

  it('still takes a typed path when the paths cannot be read', async () => {
    renderSearch({
      selfPaths: () => Promise.reject(new Error('offline')),
      distanceUnit: vi.fn()
    })
    expect(await screen.findByRole('alert')).toBeTruthy()
    query('a.b')
    expect(screen.getByRole('link', { name: /Use the path as typed/ })).toBeTruthy()
  })
})

describe('KindPicker', () => {
  afterEach(cleanup)

  function renderPicker(path: string) {
    const choose = vi.fn()
    render(<KindPicker paths={pathSource} path={path} backHref="#back" choose={choose} />)
    return choose
  }

  it('says the value now and its zones, and continues with the kind chosen', async () => {
    const choose = renderPicker('electrical.batteries.house.voltage')
    expect(await screen.findByText(/House battery voltage, now/)).toBeTruthy()
    expect(screen.getByText(/Its metadata has zones: alarm, warn\./)).toBeTruthy()
    const go = screen.getByRole('button', { name: 'Continue' })
    expect(go).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('radio', { name: /Below a limit/ }))
    fireEvent.click(go)
    expect(choose).toHaveBeenCalledWith('below')
  })

  it('offers no kind that needs a number for a value that is not one', async () => {
    renderPicker('propulsion.port.state')
    await screen.findByText(/now/)
    expect(screen.queryByRole('radio', { name: /Below a limit/ })).toBeNull()
    expect(screen.getByRole('radio', { name: /A given state/ })).toBeTruthy()
  })
})
