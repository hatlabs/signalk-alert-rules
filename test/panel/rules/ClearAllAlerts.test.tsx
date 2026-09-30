// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeAlerts, ClearAllAlerts } from '../../../src/panel/rules/ClearAllAlerts'
import { instance, ruleEntry } from '../fixtures'

function renderControl(count: number) {
  const turnOff = vi.fn(() => Promise.resolve())
  render(<ClearAllAlerts activeAlerts={count} turnOff={turnOff} />)
  return turnOff
}

async function click(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button)
    await Promise.resolve()
  })
}

describe('activeAlerts', () => {
  it('counts the active instances of every rule', () => {
    const active = instance({ badge: 'alertActive', active: true })
    const rules = [
      ruleEntry({ status: { instances: [active, instance(), active] } }),
      ruleEntry({ slug: 'b', status: { instances: [active] } }),
      ruleEntry({ slug: 'c', status: { instances: [] } })
    ]
    expect(activeAlerts(rules)).toBe(3)
  })
})

describe('ClearAllAlerts', () => {
  afterEach(cleanup)

  it('confirms clearing all alerts, showing the count and that evaluation stops', async () => {
    const turnOff = renderControl(3)
    await click(screen.getByRole('button', { name: /clear all skar alerts/i }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toMatch(/3 active alerts/)
    expect(dialog.textContent).toMatch(/stops evaluating every rule/i)
    expect(turnOff).not.toHaveBeenCalled()
    await click(within(dialog).getByRole('button', { name: /clear all alerts/i }))
    expect(turnOff).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('names a single alert in the singular', () => {
    renderControl(1)
    fireEvent.click(screen.getByRole('button', { name: /clear all skar alerts/i }))
    expect(screen.getByRole('alertdialog').textContent).toMatch(/1 active alert\b/)
  })

  it('cancels without clearing', () => {
    const turnOff = renderControl(2)
    fireEvent.click(screen.getByRole('button', { name: /clear all skar alerts/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(turnOff).not.toHaveBeenCalled()
  })
})
