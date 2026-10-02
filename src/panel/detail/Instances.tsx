import { useId, type Ref } from 'react'
import type { InstanceStatus, RuleInfo } from '../api'
import { PriorityBadge } from '../list/PriorityBadge'
import { StateChip } from '../list/StateChip'
import { instanceName, type RuleDisplay } from '../rules/describe'
import { instanceFact } from './explain'

/** Whether an instance is the one a link names: an alert path carries the segment, people the name. */
export function isLinked(i: InstanceStatus, linked: string | undefined): boolean {
  return linked !== undefined && (i.instance?.name === linked || i.instance?.segment === linked)
}

export interface InstancesProps {
  instances: InstanceStatus[]
  rule: RuleInfo
  display: RuleDisplay
  now: number
  /** The instance a link names, to mark. */
  linked?: string
  /** The linked instance's row, which takes focus when the operator follows the link. */
  linkedRef?: Ref<HTMLLIElement>
}

/** Every instance of a wildcard rule, each with its own state and value. */
export function Instances({ instances, rule, display, now, linked, linkedRef }: InstancesProps) {
  const headingId = useId()
  return (
    <section className="skar-card skar-card-flush" aria-labelledby={headingId}>
      <h3 id={headingId} className="skar-card-title">
        Instances
      </h3>
      <ul className="skar-instances" aria-labelledby={headingId}>
        {instances.map((i, index) => (
          <li
            key={i.instance?.segment ?? index}
            className={isLinked(i, linked) ? 'skar-instance skar-instance-linked' : 'skar-instance'}
            {...(isLinked(i, linked) ? { ref: linkedRef, tabIndex: -1, 'aria-current': true } : {})}
          >
            <span className="skar-row-main">
              <span className="skar-row-name">{instanceName(i)}</span>
              <span className="skar-row-fact">{instanceFact(i, rule, display, now)}</span>
            </span>
            <span className="skar-row-state">
              <StateChip kind={i.condition} />
              {i.condition === 'alerting' && i.priority !== undefined && (
                <PriorityBadge priority={i.priority} />
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
