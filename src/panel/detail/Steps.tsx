import { useId } from 'react'
import type { RuleEntry } from '../api'
import { article, clearsWhen, ruleClear, stepCondition, type RuleDisplay } from '../rules/describe'
import { CheckIcon } from './icons'
import { PriorityBadge } from '../list/PriorityBadge'

/**
 * When the alert ends: only once the condition is back past the first step.
 * A clear margin or delay puts that point in the facts' Clears row, so the
 * ladder then says only that the alert keeps the step it reached.
 */
function clearHint(
  entry: RuleEntry,
  display: RuleDisplay,
  reached: string | undefined
): string | undefined {
  // The row decides: the ladder drops its clear point exactly when the row shows it.
  if (clearsWhen(entry.rule, display) !== undefined) {
    return reached === undefined
      ? undefined
      : `It stays ${article(reached)} ${reached} until it clears.`
  }
  const back = ruleClear(entry.rule, display)
  const clears =
    back === undefined
      ? 'Clears when the first step no longer holds.'
      : `Clears when the value is back ${back.where}.`
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
  const hint = clearHint(entry, display, reached === undefined ? undefined : status.priority)
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
      {hint !== undefined && <p className="skar-hint">{hint}</p>}
    </section>
  )
}
