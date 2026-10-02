// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Confirm, ConfirmSheet } from '../../../src/panel/rules/Confirm'

describe('Confirm', () => {
  afterEach(cleanup)

  it('sends the action once and disables both buttons while it runs', async () => {
    let finish: () => void = () => undefined
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    render(
      <Confirm title="Delete?" confirmLabel="Delete" onConfirm={onConfirm} onCancel={vi.fn()}>
        <p>Gone for good.</p>
      </Confirm>
    )
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Delete' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(confirm.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /cancel/i }).disabled).toBe(true)
    await act(async () => {
      finish()
      await Promise.resolve()
    })
  })
})

describe('ConfirmSheet', () => {
  afterEach(cleanup)

  function renderSheet(onConfirm: () => Promise<void> = () => Promise.resolve()) {
    const onCancel = vi.fn()
    const { container } = render(
      <ConfirmSheet
        title="Disable?"
        confirmLabel="Disable rule"
        tone="dark"
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        <input aria-label="Why?" />
      </ConfirmSheet>
    )
    const backdrop = container.querySelector<HTMLElement>('.skar-sheet-backdrop')
    if (backdrop === null) throw new Error('no backdrop')
    return { onCancel, backdrop }
  }

  it('starts on Cancel and keeps Tab and Shift+Tab inside the sheet', () => {
    renderSheet()
    const sheet = screen.getByRole('alertdialog', { name: 'Disable?' })
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const confirm = screen.getByRole('button', { name: 'Disable rule' })
    const note = screen.getByRole('textbox', { name: 'Why?' })
    expect(document.activeElement).toBe(cancel)
    confirm.focus()
    fireEvent.keyDown(sheet, { key: 'Tab' })
    expect(document.activeElement).toBe(note)
    fireEvent.keyDown(sheet, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm)
  })

  it('cancels on the dimmed page', () => {
    const { onCancel, backdrop } = renderSheet()
    fireEvent.click(backdrop)
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('cancels by neither the dimmed page nor Escape while confirming', async () => {
    let finish: () => void = () => undefined
    const { onCancel, backdrop } = renderSheet(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Disable rule' }))
    fireEvent.click(backdrop)
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    await act(async () => {
      finish()
      await Promise.resolve()
    })
  })
})
