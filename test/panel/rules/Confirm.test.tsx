// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Confirm } from '../../../src/panel/rules/Confirm'

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
