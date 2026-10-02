import type { Condition } from '../api'

interface BadgeLook {
  label: string
  /** Distinct per badge, so the badge reads without colour. */
  icon: string
  /** Bootstrap contextual colour, from the admin UI's theme. */
  tone: string
}

/** What a badge shows: a condition, or a disabled rule. */
export type BadgeKind = Condition | 'disabled'

export const BADGE_LOOK: Readonly<Record<BadgeKind, BadgeLook>> = {
  alerting: { label: 'Alerting', icon: '▲', tone: 'danger' },
  present: { label: 'Condition present', icon: '◆', tone: 'secondary' },
  problem: { label: 'Problem', icon: '⚠', tone: 'warning' },
  noData: { label: 'No data', icon: '∅', tone: 'light' },
  normal: { label: 'Normal', icon: '✓', tone: 'success' },
  disabled: { label: 'Disabled', icon: '⊘', tone: 'secondary' }
}

/**
 * A rule's or an instance's badge: Disabled for a disabled rule, otherwise
 * its condition. It is deliberately not a live region: the list polls every
 * few seconds and a screen reader would otherwise announce every row each
 * time.
 */
export function StatusBadge({ kind }: { kind: BadgeKind }) {
  const look = BADGE_LOOK[kind]
  return (
    <div className="skar-status">
      <span className={`badge text-bg-${look.tone}`}>
        <span aria-hidden="true">{look.icon}</span> {look.label}
      </span>
    </div>
  )
}
