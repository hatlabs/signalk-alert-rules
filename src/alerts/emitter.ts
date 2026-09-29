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
 * - held: the condition exited and core keeps the alert for acknowledgement;
 *   heartbeats are null until core drops it.
 */
type Phase = 'pending' | 'active' | 'held'

interface Slot {
  phase: Phase
  /** What the alert is raised with; absent once held. */
  value?: AlertValue
  evidence: () => boolean
  lastBeat: number
  conflict?: string
}

export interface AlertStatus {
  /** Another source owns the alert path, so SKAR emits nothing for it. */
  conflict?: string
  heldByCore: boolean
  /** No input evidence, so heartbeats have stopped and core will mark the alert stale. */
  awaitingInput: boolean
}

/**
 * Turns rule conditions into core alerts through `alerts.*` delta ingress.
 * SKAR reports whether a condition is present; what happens to the alert
 * after that is core's lifecycle. So while a condition is active, a heartbeat
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

  clear(path: string, now: number): void {
    const slot = this.slots.get(path)
    if (slot === undefined) return
    if (slot.phase === 'pending' || !this.checkOwnership(slot, this.deps.alerts.getByPath(path))) {
      this.slots.delete(path)
      return
    }
    if (slot.phase === 'active') this.deps.send(path, null)
    slot.phase = 'held'
    slot.value = undefined
    slot.lastBeat = now
  }

  /**
   * Takes over an alert core already holds for SKAR, without raising it. A
   * live alert is heartbeated once at once, whatever the evidence: core
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
    const slot: Slot = alert.condition
      ? { phase: 'active', value, evidence, lastBeat: now }
      : { phase: 'held', evidence, lastBeat: now }
    this.slots.set(alert.path, slot)
    if (!alert.stale) this.deps.send(alert.path, slot.value ?? null)
  }

  beat(now: number): void {
    for (const [path, slot] of this.slots) {
      if (now - slot.lastBeat < HEARTBEAT_S) continue
      slot.lastBeat = now
      const alert = this.deps.alerts.getByPath(path)
      if (!this.checkOwnership(slot, alert)) continue
      switch (slot.phase) {
        case 'pending':
          if (slot.value !== undefined) this.activate(path, slot, slot.value)
          break
        case 'active':
          if (slot.evidence() && slot.value !== undefined) this.deps.send(path, slot.value)
          break
        case 'held':
          if (alert === null) this.slots.delete(path)
          else if (!alert.condition && slot.evidence()) this.deps.send(path, null)
          break
      }
    }
  }

  status(path: string): AlertStatus | undefined {
    const slot = this.slots.get(path)
    if (slot === undefined) return undefined
    return {
      conflict: slot.conflict,
      heldByCore: slot.phase === 'held',
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
