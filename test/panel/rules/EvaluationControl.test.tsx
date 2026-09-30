// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeAlerts, EvaluationControl } from '../../../src/panel/rules/EvaluationControl'
import { instance, ruleEntry } from '../fixtures'

function renderControl(enabled: boolean, count: number) {
  const setEvaluation = vi.fn((_enabled: boolean) => Promise.resolve())
  render(
    <EvaluationControl
      evaluationEnabled={enabled}
      activeAlerts={count}
      setEvaluation={setEvaluation}
    />
  )
  return setEvaluation
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

describe('EvaluationControl', () => {
  afterEach(cleanup)

  it('confirms clearing all alerts, showing the count and that evaluation stops', async () => {
    const setEvaluation = renderControl(true, 3)
    await click(screen.getByRole('button', { name: /clear all skar alerts/i }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toMatch(/3 active alerts/)
    expect(dialog.textContent).toMatch(/stops evaluating every rule/i)
    expect(setEvaluation).not.toHaveBeenCalled()
    await click(within(dialog).getByRole('button', { name: /clear all alerts/i }))
    expect(setEvaluation).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('names a single alert in the singular', () => {
    renderControl(true, 1)
    fireEvent.click(screen.getByRole('button', { name: /clear all skar alerts/i }))
    expect(screen.getByRole('alertdialog').textContent).toMatch(/1 active alert\b/)
  })

  it('cancels without clearing', () => {
    const setEvaluation = renderControl(true, 2)
    fireEvent.click(screen.getByRole('button', { name: /clear all skar alerts/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(setEvaluation).not.toHaveBeenCalled()
  })

  it('says evaluation is off and turns it back on', async () => {
    const setEvaluation = renderControl(false, 0)
    expect(screen.getByText(/evaluation is off/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /clear all skar alerts/i })).toBeNull()
    await click(screen.getByRole('button', { name: /turn evaluation on/i }))
    expect(setEvaluation).toHaveBeenCalledWith(true)
  })

  it('shows why turning evaluation on failed', async () => {
    render(
      <EvaluationControl
        evaluationEnabled={false}
        activeAlerts={0}
        setEvaluation={() => Promise.reject(new Error('the alerts could not be read'))}
      />
    )
    await click(screen.getByRole('button', { name: /turn evaluation on/i }))
    expect(screen.getByRole('alert').textContent).toContain('the alerts could not be read')
  })
})
