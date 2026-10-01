import type { Priority } from '../model/rule.js'

/** How often each alert is re-emitted: five can be lost before core's fixed 60 s source timeout. */
export const HEARTBEAT_S = 10

/** What an emission says about the alert, taken from the rule as it is now. */
export interface AlertHeader {
  priority: Priority
  message: string
  latching: boolean
}

/**
 * The value of an `alerts.*` delta that raises an alert. `references` and
 * `data` are fixed at the raise; heartbeats repeat them unchanged, and omit
 * them for an adopted alert so that core keeps what it stored.
 */
export interface AlertValue extends AlertHeader {
  /** The data paths the rule reads for the alert's instance. */
  references?: string[]
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
  list(): CoreAlert[]
}

export interface EmitterDeps {
  /** Emits the delta for a core alert path (without `alerts.`); null clears. */
  send(path: string, value: AlertValue | null): void
}

interface Slot {
  value: AlertValue
  evidence: () => boolean
  lastBeat: number
}

export interface AlertStatus {
  /** No input evidence, so heartbeats have stopped and core will mark the alert stale. */
  awaitingInput: boolean
}

/**
 * Turns rule conditions into core alerts through `alerts.*` delta ingress.
 * SKAR reports whether a condition is present; what happens to the alert
 * after that is core's lifecycle, including what a repeat does to an alert
 * core no longer holds as active. A clear reports that the condition ended
 * and is the last thing SKAR says about the alert. Heartbeats repeat the
 * raise while `evidence` says the rule's input is reporting; without it core
 * marks the alert stale instead of SKAR clearing it. A latching raise is the
 * whole of its alert. Stopping never clears.
 */
export class AlertEmitter {
  private readonly slots = new Map<string, Slot>()

  constructor(private readonly deps: EmitterDeps) {}

  /**
   * A latching raise reports a momentary event, which core holds as ended
   * from the start and announces anew on every raise, so it is sent once and
   * not held: a heartbeat or repeat of it would be another occurrence.
   */
  raise(path: string, value: AlertValue, evidence: () => boolean, now: number): void {
    if (!value.latching) this.slots.set(path, { value, evidence, lastBeat: now })
    this.deps.send(path, value)
  }

  clear(path: string): void {
    if (!this.slots.delete(path)) return
    this.deps.send(path, null)
  }

  /**
   * Takes over an active alert core already holds for SKAR, without raising
   * it. Its emissions carry the rule's current header and no data, so core
   * hears a rule edited while SKAR was down and keeps the data it stored. A
   * live alert is heartbeated once at once, whatever the evidence. An alert
   * already stale is left alone, so it is not shown live for a minute with no
   * evidence behind it; the first heartbeat with evidence brings it back.
   */
  adopt(alert: CoreAlert, header: AlertHeader, evidence: () => boolean, now: number): void {
    const value = { ...header }
    this.slots.set(alert.path, { value, evidence, lastBeat: now })
    if (!alert.stale) this.deps.send(alert.path, value)
  }

  /** Replaces what an active alert's next emissions say; its data stays as raised. */
  revise(path: string, header: AlertHeader): void {
    const slot = this.slots.get(path)
    if (slot !== undefined) slot.value = { ...slot.value, ...header }
  }

  /**
   * Emits an active alert at once, as an early heartbeat, so a revised
   * priority reaches core without waiting for the next beat. Without input
   * evidence it waits for the beat like any other emission.
   */
  repeat(path: string, now: number): void {
    const slot = this.slots.get(path)
    if (slot === undefined) return
    slot.lastBeat = now
    if (slot.evidence()) this.deps.send(path, slot.value)
  }

  beat(now: number): void {
    for (const [path, slot] of this.slots) {
      if (now - slot.lastBeat < HEARTBEAT_S) continue
      slot.lastBeat = now
      if (slot.evidence()) this.deps.send(path, slot.value)
    }
  }

  status(path: string): AlertStatus | undefined {
    const slot = this.slots.get(path)
    return slot === undefined ? undefined : { awaitingInput: !slot.evidence() }
  }
}
