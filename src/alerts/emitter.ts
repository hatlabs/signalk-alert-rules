import type { Priority } from '../model/rule.js'

/** How often each alert is re-emitted: a third of core's fixed 60 s source timeout. */
export const HEARTBEAT_S = 20

/** The value of an `alerts.*` delta that raises an alert; heartbeats repeat it unchanged. */
export interface AlertValue {
  priority: Priority
  message: string
  latching: boolean
  data?: Record<string, unknown>
}

/** The fields of a core alert SKAR reads. */
export interface CoreAlert {
  /** Without the `alerts.` prefix. */
  path: string
  $source: string
  priority: Priority
  message: string
  latching: boolean
  data?: Record<string, unknown>
  condition: boolean
  /** Core's liveness timer ran out; set until the source emits again. */
  stale: boolean
}

export interface AlertsReader {
  getByPath(path: string): CoreAlert | null
  list(): CoreAlert[]
}

export interface EmitterDeps {
  pluginId: string
  alerts: AlertsReader
  /** Emits the delta for a core alert path (without `alerts.`); null clears. */
  send(path: string, value: AlertValue | null): void
}

/**
 * - pending: the condition is active but another source owns the path.
 * - active: raised; heartbeats repeat the raise.
 */
type Phase = 'pending' | 'active'

interface Slot {
  phase: Phase
  /** What the alert is raised with. */
  value: AlertValue
  evidence: () => boolean
  lastBeat: number
  conflict?: string
}

export interface AlertStatus {
  /** Another source owns the alert path, so SKAR emits nothing for it. */
  conflict?: string
  /** No input evidence, so heartbeats have stopped and core will mark the alert stale. */
  awaitingInput: boolean
}

/**
 * Turns rule conditions into core alerts through `alerts.*` delta ingress.
 * SKAR reports whether a condition is present; what happens to the alert
 * after that is core's lifecycle. A clear reports that the condition ended
 * and is the last thing SKAR says about the alert, even while core keeps it
 * for acknowledgement. While a condition is active, a heartbeat
 * that finds the alert missing from core, or with its condition reported
 * ended, raises it again. Core does not check who owns a path, so before every
 * raise, heartbeat and clear the emitter reads the alert and does nothing if
 * another source owns it. Heartbeats run only while `evidence` says the rule's
 * input is reporting; without it core marks the alert stale instead of SKAR
 * clearing it. Stopping never clears.
 */
export class AlertEmitter {
  private readonly slots = new Map<string, Slot>()

  constructor(private readonly deps: EmitterDeps) {}

  raise(path: string, value: AlertValue, evidence: () => boolean, now: number): void {
    const slot: Slot = { phase: 'pending', value, evidence, lastBeat: now }
    this.slots.set(path, slot)
    if (this.checkOwnership(slot, this.deps.alerts.getByPath(path)))
      this.activate(path, slot, value)
  }

  clear(path: string): void {
    const slot = this.slots.get(path)
    if (slot === undefined) return
    this.slots.delete(path)
    if (slot.phase === 'active' && this.checkOwnership(slot, this.deps.alerts.getByPath(path))) {
      this.deps.send(path, null)
    }
  }

  /**
   * Takes over an active alert core already holds for SKAR, without raising
   * it. A live alert is heartbeated once at once, whatever the evidence: core
   * restores stored alerts without a liveness timer and arms one only on
   * delta ingress, so without this an adopted alert whose input never returns
   * would never go stale. An alert already stale is left alone, so it is not
   * shown live for a minute with no evidence behind it; the first heartbeat
   * with evidence brings it back.
   */
  adopt(alert: CoreAlert, evidence: () => boolean, now: number): void {
    const { priority, message, latching, data } = alert
    const value =
      data === undefined ? { priority, message, latching } : { priority, message, latching, data }
    this.slots.set(alert.path, { phase: 'active', value, evidence, lastBeat: now })
    if (!alert.stale) this.deps.send(alert.path, value)
  }

  beat(now: number): void {
    for (const [path, slot] of this.slots) {
      if (now - slot.lastBeat < HEARTBEAT_S) continue
      slot.lastBeat = now
      if (!this.checkOwnership(slot, this.deps.alerts.getByPath(path))) continue
      if (slot.phase === 'pending') this.activate(path, slot, slot.value)
      else if (slot.evidence()) this.deps.send(path, slot.value)
    }
  }

  status(path: string): AlertStatus | undefined {
    const slot = this.slots.get(path)
    if (slot === undefined) return undefined
    return {
      conflict: slot.conflict,
      awaitingInput: !slot.evidence()
    }
  }

  /** Records whether another source owns the alert, and returns whether SKAR may emit for it. */
  private checkOwnership(slot: Slot, alert: CoreAlert | null): boolean {
    if (alert !== null && alert.$source !== this.deps.pluginId) {
      slot.conflict = `the alert path is in use by ${alert.$source}`
      return false
    }
    slot.conflict = undefined
    return true
  }

  private activate(path: string, slot: Slot, value: AlertValue): void {
    slot.phase = 'active'
    this.deps.send(path, value)
  }
}
