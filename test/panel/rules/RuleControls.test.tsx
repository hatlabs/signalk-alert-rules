// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuleEntry } from '../../../src/panel/api'
import { RuleDetail } from '../../../src/panel/rules/RuleDetail'
import { instance, ruleEntry } from '../fixtures'

const active = ruleEntry({
  status: {
    condition: 'alerting',
    reason: 'alertActive',
    instances: [instance({ condition: 'alerting', reason: 'alertActive', priority: 'alarm' })]
  }
})

const disabled = ruleEntry({
  disabled: { since: '2026-09-30T12:00:00.000Z', actor: 'admin' },
  status: { condition: 'present', reason: 'conditionPresent' }
})

function renderControls(entry: RuleEntry) {
  const disable = vi.fn((_note: string) => Promise.resolve())
  const enable = vi.fn(() => Promise.resolve())
  render(
    <RuleDetail
      entry={entry}
      backHref="#"
      reset={() => Promise.resolve()}
      disable={disable}
      enable={enable}
    />
  )
  return { disable, enable }
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
    await Promise.resolve()
  })
}

describe('RuleDetail controls', () => {
  afterEach(cleanup)

  it('disables after a confirmation that asks for an optional note', async () => {
    const { disable } = renderControls(active)
    const trigger = screen.getByRole('button', { name: 'Disable…' })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('alertdialog', { name: /disable oil pressure low/i })
    expect(dialog.textContent).toMatch(/raises no alert until someone enables it again/i)
    expect(dialog.textContent).toMatch(/keeps evaluating/i)
    expect(dialog.textContent).toMatch(/clears its 1 active alert\b/i)
    const note = within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: /note/i })
    expect(note.maxLength).toBe(500)
    fireEvent.change(note, { target: { value: ' paddlewheel fouled ' } })
    expect(disable).not.toHaveBeenCalled()
    await click(within(dialog).getByRole('button', { name: 'Disable' }))
    expect(disable).toHaveBeenCalledWith('paddlewheel fouled')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('disables without a note', async () => {
    const { disable } = renderControls(ruleEntry())
    fireEvent.click(screen.getByRole('button', { name: 'Disable…' }))
    await click(screen.getByRole('button', { name: 'Disable' }))
    expect(disable).toHaveBeenCalledWith('')
  })

  it('keeps the dialog and the typed note when disabling is refused', async () => {
    const { disable } = renderControls(ruleEntry())
    disable.mockRejectedValue(new Error('no such rule'))
    fireEvent.click(screen.getByRole('button', { name: 'Disable…' }))
    fireEvent.change(screen.getByRole('textbox', { name: /note/i }), {
      target: { value: 'typed' }
    })
    await click(screen.getByRole('button', { name: 'Disable' }))
    expect(screen.getByRole('alertdialog').textContent).toContain('no such rule')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: /note/i }).value).toBe('typed')
  })

  it('enables a disabled rule at once', async () => {
    const { enable } = renderControls(disabled)
    expect(screen.queryByRole('button', { name: 'Disable…' })).toBeNull()
    await click(screen.getByRole('button', { name: 'Enable' }))
    expect(enable).toHaveBeenCalled()
  })

  it('returns focus to Enable once the request finishes', async () => {
    const { enable } = renderControls(disabled)
    let finish: () => void = () => undefined
    enable.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Enable' })
    button.focus()
    await click(button)
    expect(button.disabled).toBe(true)
    // A browser drops focus to the page as the button is disabled; jsdom neither does
    // that nor blurs a disabled button, but it does when the focused element goes.
    const elsewhere = document.body.appendChild(document.createElement('input'))
    elsewhere.focus()
    elsewhere.remove()
    expect(document.activeElement).toBe(document.body)
    await act(async () => {
      finish()
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(button)
  })

  it("shows the server's message when enabling is refused", async () => {
    const { enable } = renderControls(disabled)
    enable.mockRejectedValue(new Error('no such rule'))
    await click(screen.getByRole('button', { name: 'Enable' }))
    expect(screen.getByRole('alert').textContent).toContain('no such rule')
  })

  it('offers no controls where the rule cannot be changed', () => {
    render(<RuleDetail entry={active} backHref="#" reset={() => Promise.resolve()} />)
    expect(screen.queryByRole('button', { name: /disable/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /enable/i })).toBeNull()
  })
})
