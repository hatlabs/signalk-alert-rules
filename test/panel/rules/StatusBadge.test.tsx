// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BADGES } from '../../../src/panel/api'
import { StatusBadge } from '../../../src/panel/rules/StatusBadge'

describe('StatusBadge', () => {
  afterEach(cleanup)

  const LABELS = {
    disabled: 'Disabled',
    suppressed: 'Suppressed',
    errored: 'Errored',
    inactive: 'Inactive',
    alertActive: 'Alert active',
    gatedOff: 'Gated off',
    inputUnavailable: 'Input unavailable',
    neverSeen: 'Never seen',
    timerRunning: 'Timer running',
    idle: 'Idle'
  }

  it.each(BADGES)('shows %s as text with an icon, not colour alone', (badge) => {
    const { container } = render(<StatusBadge status={{ badge, subLabels: [] }} />)
    expect(container.textContent).toContain(LABELS[badge])
    const icon = container.querySelector('[aria-hidden="true"]')
    expect(icon?.textContent.trim()).not.toBe('')
  })

  it('gives every badge its own icon', () => {
    const icons = BADGES.map((badge) => {
      const { container } = render(<StatusBadge status={{ badge, subLabels: [] }} />)
      const icon = container.querySelector('[aria-hidden="true"]')?.textContent
      cleanup()
      return icon
    })
    expect(new Set(icons).size).toBe(BADGES.length)
  })

  it('carries the reason of a disabled, errored or inactive badge', () => {
    const { container } = render(
      <StatusBadge status={{ badge: 'errored', reason: 'evaluation threw', subLabels: [] }} />
    )
    expect(container.textContent).toMatch(/errored.*evaluation threw/i)
  })

  it('says where a suppression comes from and that it ends by itself', () => {
    const { container } = render(
      <StatusBadge
        status={{
          badge: 'suppressed',
          suppression: { scope: 'input', path: 'propulsion.port.revolutions', autoEndAfter: 600 },
          subLabels: []
        }}
      />
    )
    expect(container.textContent).toMatch(
      /suppressed.*input propulsion\.port\.revolutions.*ends by itself/i
    )
  })

  it('shows what a rule suppression is', () => {
    const { container } = render(
      <StatusBadge
        status={{ badge: 'suppressed', suppression: { scope: 'rule' }, subLabels: [] }}
      />
    )
    expect(container.textContent).toMatch(/suppressed.*rule/i)
    expect(container.textContent).not.toMatch(/ends by itself/i)
  })

  it('shows the sub-labels in the order the server gives', () => {
    render(
      <StatusBadge
        status={{
          badge: 'alertActive',
          subLabels: ['gateInputUnavailable', 'waitingForClear', 'awaitingInput']
        }}
      />
    )
    const labels = screen.getAllByRole('listitem').map((item) => item.textContent)
    expect(labels).toEqual(['gate input unavailable', 'waiting for clear', 'awaiting input'])
  })
})
