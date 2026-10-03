import { useId } from 'react'
import type { RuleEntry, RuleInfo } from '../api'
import { article, stepCondition, type RuleDisplay } from '../rules/describe'
import { CheckIcon } from './icons'
import { PriorityBadge } from '../list/PriorityBadge'
import { formatDuration } from '../../format'

const OPPOSITE: Readonly<Partial<Record<string, string>>> = { below: 'above', above: 'below' }

/**
 * Where the value is back to once the first step no longer holds, for a
 * limit on the value: past the first step by the rule's clear margin.
 */
function backTo(rule: RuleInfo, display: RuleDisplay): string | undefined {
  const first = rule.steps[0]
  const margin = rule.hysteresis ?? 0
  if (rule.detector.type === 'outside') {
    return first.low === undefined || first.high === undefined
      ? undefined
      : `between ${display.range(first.low + margin, first.high - margin, 'and')}`
  }
  const back = OPPOSITE[rule.detector.direction ?? '']
  if (rule.detector.type !== 'sustained' || back === undefined || first.limit === undefined) {
    return undefined
  }
  return `${back} ${display.value(back === 'above' ? first.limit + margin : first.limit - margin)}`
}

/**
 * When the alert ends: only once the condition is back past the first step,
 * by the clear margin and for the clear delay when the rule sets them.
 */
function clearHint(entry: RuleEntry, display: RuleDisplay, reached: string | undefined): string {
  const { hysteresis = 0, clearDuration = 0 } = entry.rule
  const back = backTo(entry.rule, display)
  const delay = clearDuration > 0 ? ` for ${formatDuration(clearDuration)}` : ''
  const clears =
    back === undefined
      ? 'Clears when the first step no longer holds.'
      : hysteresis > 0 || clearDuration > 0
        ? `Clears once the value is back ${back}${delay}.`
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
