// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BADGE_LOOK, StatusBadge, type BadgeKind } from '../../../src/panel/rules/StatusBadge'

const KINDS = Object.keys(BADGE_LOOK) as BadgeKind[]

describe('StatusBadge', () => {
  afterEach(cleanup)

  const LABELS: Record<BadgeKind, string> = {
    alerting: 'Alerting',
    present: 'Condition present',
    problem: 'Problem',
    noData: 'No data',
    normal: 'Normal',
    disabled: 'Disabled'
  }

  it.each(KINDS)('shows %s as text with an icon, not colour alone', (kind) => {
    const { container } = render(<StatusBadge kind={kind} />)
    expect(container.textContent).toContain(LABELS[kind])
    const icon = container.querySelector('[aria-hidden="true"]')
    expect(icon?.textContent.trim()).not.toBe('')
  })

  it('gives every badge its own icon', () => {
    const icons = KINDS.map((kind) => {
      const { container } = render(<StatusBadge kind={kind} />)
      const icon = container.querySelector('[aria-hidden="true"]')?.textContent
      cleanup()
      return icon
    })
    expect(new Set(icons).size).toBe(KINDS.length)
  })
})
