import { useState } from 'react'
import type { RuleEntry } from '../api'
import { Confirm } from './Confirm'

/** The alerts SKAR's rules hold now, as their status reports them. */
export function activeAlerts(rules: RuleEntry[]): number {
  return rules.reduce(
    (sum, entry) => sum + entry.status.instances.filter((i) => i.active === true).length,
    0
  )
}

export interface ClearAllAlertsProps {
  activeAlerts: number
  /** Resolves once the server has turned evaluation off; a rejection is shown. */
  turnOff: () => Promise<void>
}

/**
 * Clearing all of SKAR's alerts is turning evaluation off: clearing them
 * while rules keep evaluating would only raise them again. It sits apart from
 * the per-rule actions so it is not hit by mistake.
 */
export function ClearAllAlerts({ activeAlerts: count, turnOff }: ClearAllAlertsProps) {
  const [confirming, setConfirming] = useState(false)
  const alerts = `${String(count)} active ${count === 1 ? 'alert' : 'alerts'}`
  return (
    <div className="skar-evaluation">
      <button
        type="button"
        className="btn btn-outline-danger btn-sm"
        disabled={confirming}
        onClick={() => {
          setConfirming(true)
        }}
      >
        Clear all SKAR alerts…
      </button>
      {confirming && (
        <Confirm
          title="Clear all SKAR alerts?"
          confirmLabel="Clear all alerts"
          onConfirm={async () => {
            await turnOff()
            setConfirming(false)
          }}
          onCancel={() => {
            setConfirming(false)
          }}
        >
          <p>
            This clears every alert SKAR raised, {alerts} now, and stops evaluating every rule until
            evaluation is turned back on.
          </p>
          <p className="mb-0">
            Rules can still be edited meanwhile, and accumulator totals are kept. When evaluation is
            on again, each rule raises its alert anew once its condition holds.
          </p>
        </Confirm>
      )}
    </div>
  )
}
