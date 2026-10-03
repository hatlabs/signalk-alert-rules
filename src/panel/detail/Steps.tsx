import { useId } from 'react'
import type { RuleEntry, RuleInfo } from '../api'
import { article, stepCondition, type RuleDisplay } from '../rules/describe'
import { CheckIcon } from './icons'
import { PriorityBadge } from '../list/PriorityBadge'

const OPPOSITE: Readonly<Partial<Record<string, string>>> = { below: 'above', above: 'below' }

/** Where the value is back to once the first step no longer holds, for a limit on the value. */
function backTo(rule: RuleInfo, display: RuleDisplay): string | undefined {
  const first = rule.steps[0]
  if (rule.detector.type === 'outside') {
    return first.low === undefined || first.high === undefined
      ? undefined
      : `between ${display.range(first.low, first.high, 'and')}`
  }
  const back = OPPOSITE[rule.detector.direction ?? '']
  return rule.detector.type === 'sustained' && back !== undefined && first.limit !== undefined
    ? `${back} ${display.value(first.limit)}`
    : undefined
}

/** When the alert ends: only once the condition is back past the first step. */
function clearHint(entry: RuleEntry, display: RuleDisplay, reached: string | undefined): string {
  const back = backTo(entry.rule, display)
  const clears =
    back === undefined
      ? 'Clears when the first step no longer holds.'
      : `Clears when the value is back ${back}.`
  return reached === undefined
    ? clears
    : `${clears} It stays ${article(reached)} ${reached} until then.`
}

/**
 * The steps an alert climbs, the one it has reached marked: shown for a rule
 * with more than one step, where the climb is not obvious from its priority.
 */
export function Steps({ entry, display }: { entry: RuleEntry; display: RuleDisplay }) {
  const headingId = useId()
  const { rule, status } = entry
  if (rule.steps.length < 2) return null
  const alerting = status.condition === 'alerting'
  const reached = alerting ? (status.step ?? 0) : undefined
  return (
    <section className="skar-card" aria-labelledby={headingId}>
      <h3 id={headingId} className="skar-card-title">
        Steps
      </h3>
      <ol className="skar-ladder" aria-labelledby={headingId}>
        {rule.steps.map((step, index) => (
          <li
            key={step.priority}
            className={index === reached ? 'skar-rung skar-rung-reached' : 'skar-rung'}
            {...(index === reached ? { 'aria-current': 'step' } : {})}
          >
            <PriorityBadge priority={step.priority} />
            <span className="skar-rung-condition">{stepCondition(step, rule, display)}</span>
            {reached !== undefined && index < reached && (
              <span className="skar-rung-mark">passed</span>
            )}
            {index === reached && (
              <span className="skar-rung-mark skar-rung-mark-reached">
                <CheckIcon />
                reached
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="skar-hint">
        {clearHint(entry, display, reached === undefined ? undefined : status.priority)}
      </p>
    </section>
  )
}
