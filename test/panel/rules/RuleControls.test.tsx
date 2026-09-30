// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionExpiredError, type RuleEntry } from '../../../src/panel/api'
import { RuleDetail } from '../../../src/panel/rules/RuleDetail'
import { instance, ruleEntry } from '../fixtures'

const active = ruleEntry({
  status: {
    badge: 'alertActive',
    instances: [instance({ badge: 'alertActive', active: true, priority: 'alarm' })]
  }
})

function renderControls(entry: RuleEntry) {
  const setEnabled = vi.fn((_enabled: boolean) => Promise.resolve())
  const setNote = vi.fn((_note: string) => Promise.resolve())
  render(
    <RuleDetail
      entry={entry}
      backHref="#"
      reset={() => Promise.resolve()}
      setEnabled={setEnabled}
      setNote={setNote}
    />
  )
  return { setEnabled, setNote }
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
    await Promise.resolve()
  })
}

describe('RuleDetail controls', () => {
  afterEach(cleanup)

  describe('enable and disable', () => {
    it('disables after a confirmation that tells disabling from suppressing', async () => {
      const { setEnabled } = renderControls(active)
      const trigger = screen.getByRole('button', { name: 'Disable…' })
      fireEvent.click(trigger)
      const dialog = screen.getByRole('alertdialog', { name: /disable oil pressure low/i })
      expect(dialog.textContent).toMatch(/off until someone enables it again/i)
      expect(dialog.textContent).toMatch(/clears its 1 active alert\b/i)
      expect(dialog.textContent).toMatch(/suppress it instead.*keeps evaluating/i)
      expect(setEnabled).not.toHaveBeenCalled()
      await click(within(dialog).getByRole('button', { name: 'Disable' }))
      expect(setEnabled).toHaveBeenCalledWith(false)
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })

    it('enables a disabled rule at once', async () => {
      const { setEnabled } = renderControls(
        ruleEntry({ enabled: false, status: { badge: 'disabled', reason: 'disabled' } })
      )
      await click(screen.getByRole('button', { name: 'Enable' }))
      expect(setEnabled).toHaveBeenCalledWith(true)
    })

    it("shows the server's message when enabling is refused", async () => {
      const { setEnabled } = renderControls(ruleEntry({ enabled: false }))
      setEnabled.mockRejectedValue(new Error('no such rule'))
      await click(screen.getByRole('button', { name: 'Enable' }))
      expect(screen.getByRole('alert').textContent).toContain('no such rule')
    })
  })

  describe('note', () => {
    it('edits the note and returns focus to the button', async () => {
      const { setNote } = renderControls(ruleEntry({ note: 'old sender' }))
      const trigger = screen.getByRole('button', { name: 'Edit note…' })
      fireEvent.click(trigger)
      const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Note' })
      expect(field.value).toBe('old sender')
      expect(field.maxLength).toBe(500)
      fireEvent.change(field, { target: { value: 'Sender replaced' } })
      await click(screen.getByRole('button', { name: 'Save note' }))
      expect(setNote).toHaveBeenCalledWith('Sender replaced')
      expect(screen.queryByRole('textbox', { name: 'Note' })).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })

    it('adds a note to a rule without one, and cancels without saving', () => {
      const { setNote } = renderControls(ruleEntry())
      fireEvent.click(screen.getByRole('button', { name: 'Add note…' }))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(setNote).not.toHaveBeenCalled()
      expect(screen.queryByRole('textbox', { name: 'Note' })).toBeNull()
    })

    it('keeps what was typed when the session has expired', async () => {
      const { setNote } = renderControls(ruleEntry())
      setNote.mockRejectedValue(new SessionExpiredError())
      fireEvent.click(screen.getByRole('button', { name: 'Add note…' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), {
        target: { value: 'typed' }
      })
      await click(screen.getByRole('button', { name: 'Save note' }))
      expect(screen.getByRole('alert').textContent).toMatch(/session has expired.*log in/i)
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Note' }).value).toBe('typed')
    })
  })

  it('offers no controls where the rule cannot be changed', () => {
    render(<RuleDetail entry={active} backHref="#" reset={() => Promise.resolve()} />)
    expect(screen.queryByRole('button', { name: /disable/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /note/i })).toBeNull()
  })
})
