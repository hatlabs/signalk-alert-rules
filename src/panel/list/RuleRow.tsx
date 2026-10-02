import { ruleName, type ListedRule } from '../api'
import type { UnitLookup } from '../signalUnits'
import { chipOf } from './attention'
import { currentFact } from './fact'
import { PriorityBadge } from './PriorityBadge'
import { StateChip } from './StateChip'

export interface RuleRowProps {
  entry: ListedRule
  href: string
  units: UnitLookup
  now: number
}

/** One rule: its name, what it is doing now, and its state, linking to its detail. */
export function RuleRow({ entry, href, units, now }: RuleRowProps) {
  const chip = chipOf(entry)
  const { priority } = entry.status
  return (
    <li>
      <a className="skar-row" href={href}>
        <span className="skar-row-main">
          <span className="skar-row-name">{ruleName(entry)}</span>
          <span className="skar-row-fact">{currentFact(entry, units, now)}</span>
        </span>
        <span className="skar-row-state">
          <StateChip kind={chip} />
          {chip === 'alerting' && priority !== undefined && <PriorityBadge priority={priority} />}
        </span>
      </a>
    </li>
  )
}
