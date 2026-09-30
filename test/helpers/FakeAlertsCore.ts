import { isDeepStrictEqual } from 'node:util'
import type { AlertValue, CoreAlert } from '../../src/alerts/emitter.js'
import { PRIORITIES, type Priority } from '../../src/model/rule.js'

const RANK = [...PRIORITIES].reverse()
const rank = (p: Priority) => RANK.indexOf(p)

type FakeAlert = CoreAlert & { state: string }

/**
 * The core alerts API's delta ingress and reads, reduced to the behaviour SKAR
 * relies on (signalk-server `src/api/alerts/deltas.ts`, `alertManager.ts`,
 * `alertStateMachine.ts`): an unchanged re-emission of a condition-active
 * alert only refreshes its description, a clear holds an unacknowledged
 * non-caution alert, acknowledging a held alert removes it, a raise on a held
 * alert reactivates it, a latching raise is a momentary event whose condition
 * has already ended and which alerts the operator every time, an omitted
 * `data` keeps the stored data, and nothing checks who owns a path. Ingress
 * is applied synchronously and there is no liveness timer; both are pinned
 * against the real server by the contract tests.
 */
export class FakeAlertsCore {
  private readonly alerts = new Map<string, FakeAlert>()
  /** Store writes: any change to an alert's description or state. */
  writes = 0
  /** Times the operator is alerted: new alerts, reactivations and priority rises. */
  alertings = 0

  ingest(source: string, path: string, value: AlertValue | null): void {
    const existing = this.alerts.get(path)
    if (value === null) {
      if (existing?.condition === true) this.clearCondition(existing)
      return
    }
    if (value.latching) {
      this.raiseOccurrence(source, path, value, existing)
      return
    }
    if (
      existing?.condition === true &&
      rank(value.priority) <= rank(existing.priority) &&
      value.message === existing.message
    ) {
      const changed =
        existing.$source !== source ||
        (value.data !== undefined && !isDeepStrictEqual(value.data, existing.data)) ||
        value.latching !== existing.latching ||
        existing.stale
      if (changed) {
        Object.assign(existing, {
          $source: source,
          data: value.data ?? existing.data,
          stale: false
        })
        existing.latching = value.latching
        this.writes++
      }
      return
    }
    const rises = existing !== undefined && rank(value.priority) > rank(existing.priority)
    const alerts =
      existing === undefined || !existing.condition || existing.state !== 'unacknowledged' || rises
    this.alerts.set(path, {
      path,
      $source: source,
      priority: existing !== undefined && !rises ? existing.priority : value.priority,
      message: value.message,
      latching: value.latching,
      data: value.data ?? existing?.data,
      condition: true,
      state: 'unacknowledged',
      stale: false
    })
    this.writes++
    if (alerts) this.alertings++
  }

  /** A source reports that the condition ended, as any source may for any alert. */
  reportEnded(_source: string, path: string): void {
    const alert = this.alerts.get(path)
    if (alert?.condition === true) this.clearCondition(alert)
  }

  /** Core's liveness timer ran out: nothing re-emitted the alert for 60 s. */
  markStale(path: string): void {
    const alert = this.alerts.get(path)
    if (alert !== undefined) alert.stale = true
  }

  acknowledge(path: string): void {
    const alert = this.alerts.get(path)
    if (alert === undefined) return
    if (alert.condition) alert.state = 'acknowledged'
    else this.alerts.delete(path)
    this.writes++
  }

  /** A raise by a source other than SKAR, such as another plugin. */
  raiseFrom(source: string, path: string, priority: Priority = 'warning'): void {
    this.ingest(source, path, { priority, message: `raised by ${source}`, latching: false })
  }

  getByPath(path: string): FakeAlert | null {
    const alert = this.alerts.get(path)
    return alert === undefined ? null : { ...alert }
  }

  list(): FakeAlert[] {
    return [...this.alerts.values()].map((a) => ({ ...a }))
  }

  private raiseOccurrence(
    source: string,
    path: string,
    value: AlertValue,
    existing: FakeAlert | undefined
  ): void {
    const keeps = existing !== undefined && rank(existing.priority) > rank(value.priority)
    this.alerts.set(path, {
      path,
      $source: source,
      priority: keeps ? existing.priority : value.priority,
      message: value.message,
      latching: true,
      data: value.data ?? existing?.data,
      condition: false,
      state: 'unacknowledged',
      stale: false
    })
    this.writes++
    this.alertings++
  }

  private clearCondition(alert: FakeAlert): void {
    alert.condition = false
    this.writes++
    if (alert.priority === 'caution' || alert.state === 'acknowledged') {
      this.alerts.delete(alert.path)
    } else {
      alert.state = alert.latching ? 'unacknowledged' : 'rtn-unacknowledged'
    }
  }
}
