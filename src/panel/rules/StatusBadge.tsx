import type { Badge, SubLabel } from '../api'

interface BadgeLook {
  label: string
  /** Distinct per badge, so the badge reads without colour. */
  icon: string
  /** Bootstrap contextual colour, from the admin UI's theme. */
  tone: string
}

export const BADGE_LOOK: Readonly<Record<Badge, BadgeLook>> = {
  disabled: { label: 'Disabled', icon: '⊘', tone: 'secondary' },
  errored: { label: 'Errored', icon: '✕', tone: 'danger' },
  inactive: { label: 'Inactive', icon: '⚠', tone: 'warning' },
  alertActive: { label: 'Alert active', icon: '▲', tone: 'danger' },
  gatedOff: { label: 'Gated off', icon: '∥', tone: 'light' },
  inputUnavailable: { label: 'Input unavailable', icon: '∅', tone: 'warning' },
  neverSeen: { label: 'Never seen', icon: '○', tone: 'light' },
  timerRunning: { label: 'Timer running', icon: '◔', tone: 'info' },
  idle: { label: 'Idle', icon: '✓', tone: 'success' }
}

export const SUB_LABEL_TEXT: Readonly<Record<SubLabel, string>> = {
  gateInputUnavailable: 'gate input unavailable',
  waitingForClear: 'waiting for clear',
  awaitingInput: 'awaiting input'
}

export interface Verdict {
  badge: Badge
  reason?: string
  subLabels: SubLabel[]
}

/**
 * A status badge with its one-line reason and its sub-labels.
 * It is deliberately not a live region: the list polls every few seconds and
 * a screen reader would otherwise announce every row each time.
 */
export function StatusBadge({ status }: { status: Verdict }) {
  const look = BADGE_LOOK[status.badge]
  const detail = status.reason
  return (
    <div className="skar-status">
      <span className={`badge text-bg-${look.tone}`}>
        <span aria-hidden="true">{look.icon}</span> {look.label}
      </span>
      {detail !== undefined && <span className="skar-status-detail"> {detail}</span>}
      {status.subLabels.length > 0 && (
        <ul className="skar-sublabels" aria-label="Also">
          {status.subLabels.map((label) => (
            <li key={label}>{SUB_LABEL_TEXT[label]}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
