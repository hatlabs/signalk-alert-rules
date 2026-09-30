// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvaluationOffBanner } from '../../../src/panel/rules/EvaluationOffBanner'

async function click(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button)
    await Promise.resolve()
  })
}

describe('EvaluationOffBanner', () => {
  afterEach(cleanup)

  it('says evaluation is off and turns it back on', async () => {
    const turnOn = vi.fn(() => Promise.resolve())
    render(<EvaluationOffBanner turnOn={turnOn} />)
    expect(screen.getByText(/evaluation is off/i)).toBeTruthy()
    await click(screen.getByRole('button', { name: /turn evaluation on/i }))
    expect(turnOn).toHaveBeenCalledOnce()
  })

  it('shows why turning evaluation on failed', async () => {
    render(
      <EvaluationOffBanner
        turnOn={() => Promise.reject(new Error('the alerts could not be read'))}
      />
    )
    await click(screen.getByRole('button', { name: /turn evaluation on/i }))
    expect(screen.getByRole('alert').textContent).toContain('the alerts could not be read')
  })
})
