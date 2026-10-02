import type { Priority } from '../model/rule.js'

/** How often each alert is re-emitted: five can be lost before core's fixed 60 s source timeout. */
export const HEARTBEAT_S = 10

/** What an emission says about the alert, taken from the rule as it is now. */
export interface AlertHeader {
  priority: Priority
  latching: boolean
}

/**
 * The value of an `alerts.*` delta that raises an alert. `references` and
 * `data` are fixed at the raise; heartbeats repeat them unchanged, and omit
 * them for an adopted alert so that core keeps what it stored.
 */
export interface AlertValue extends AlertHeader {
  message: string
  /** The data paths the rule reads for the alert's instance. */
  references?: string[]
  data?: Record<string, unknown>
}

/** An alert's value before its message is rendered, which the emitter does at each emission. */
export type AlertBody = Omit<AlertValue, 'message'>

/**
 * Renders an alert's message as it reads now. `sentLimit` is the `limit` in
 * the data core holds for the alert, for a message whose rule cannot name
 * the step the alert has reached.
 */
export type Render = (sentLimit: number | undefined) => string

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
  body: AlertBody
  /** The data core holds for the alert, which a revised limit is merged into. */
  coreData?: Record<string, unknown>
  evidence: () => boolean
  render: Render
  /** The message of the last emission; absent until the alert has been emitted. */
  sent?: string
  lastBeat: number
  /** An adopted alert waiting for {@link AlertEmitter.sendAdopted}. */
  unsent: boolean
}

export interface AlertStatus {
  /** No input evidence, so heartbeats have stopped and core will mark the alert stale. */
  awaitingInput: boolean
  /** The message last emitted, or as it reads now for an alert not emitted yet. */
  message: string
}

function limitIn(data: Record<string, unknown> | undefined): number | undefined {
  return typeof data?.limit === 'number' ? data.limit : undefined
}

/**
 * Turns rule conditions into core alerts through `alerts.*` delta ingress.
 * SKAR reports whether a condition is present; what happens to the alert
 * after that is core's lifecycle, including what a repeat does to an alert
 * core no longer holds as active. A clear reports that the condition ended
 * and is the last thing SKAR says about the alert. Heartbeats repeat the
 * raise while `evidence` says the rule's input is reporting; without it core
 * marks the alert stale instead of SKAR clearing it. The emitter alone
 * renders messages, afresh for each emission, so a message that names a
 * live value is sent at the heartbeat's pace and never faster. A latching
 * raise is the whole of its alert. Stopping never clears.
 */
export class AlertEmitter {
  private readonly slots = new Map<string, Slot>()
  /** The message of each latching alert raised and not cleared since, for its status. */
  private readonly latched = new Map<string, string>()

  constructor(private readonly deps: EmitterDeps) {}

  /**
   * A latching raise reports a momentary event, so it is sent once and never
   * heartbeated or repeated: a repeat would report another event. Its
   * message is rendered at the raise and kept for the status until the alert
   * clears.
   */
  raise(path: string, body: AlertBody, evidence: () => boolean, now: number, render: Render): void {
    if (body.latching) {
      const message = render(limitIn(body.data))
      this.latched.set(path, message)
      this.deps.send(path, { ...body, message })
      return
    }
    const slot = { body, coreData: body.data, evidence, render, lastBeat: now, unsent: false }
    this.slots.set(path, slot)
    this.emit(path, slot)
  }

  clear(path: string): void {
    this.latched.delete(path)
    if (!this.slots.delete(path)) return
    this.deps.send(path, null)
  }

  /**
   * Takes over an active alert core already holds for SKAR, without raising
   * it. Its emissions carry the rule's current header and no data, so core
   * hears a rule edited while SKAR was down and keeps the data it stored. A
   * live alert is heartbeated once by {@link sendAdopted}, whatever the
   * evidence. An alert already stale is left alone, so it is not shown live
   * for a minute with no evidence behind it; the first heartbeat with
   * evidence brings it back.
   */
  adopt(
    alert: CoreAlert,
    header: AlertHeader,
    evidence: () => boolean,
    now: number,
    render: Render
  ): void {
    this.slots.set(alert.path, {
      body: { ...header },
      coreData: alert.data,
      evidence,
      render,
      lastBeat: now,
      unsent: !alert.stale
    })
  }

  /**
   * Heartbeats each live adopted alert once, unless it has been emitted or
   * cleared since its adoption. Called once the rules have started, so the
   * message is rendered from the values their inputs replayed.
   */
  sendAdopted(): void {
    for (const [path, slot] of this.slots) if (slot.unsent) this.emit(path, slot)
  }

  /**
   * Replaces the priority an active alert's next emissions carry. Its data
   * stays as raised but for `limit`, the limit of the step it has reached.
   * Core replaces an alert's data whole, so a changed limit is sent with the
   * rest of the data core holds.
   */
  revise(path: string, priority: Priority, limit?: number): void {
    const slot = this.slots.get(path)
    if (slot === undefined) return
    slot.body = { ...slot.body, priority }
    if (limit === undefined || slot.coreData?.limit === limit) return
    slot.coreData = { ...slot.coreData, limit }
    slot.body = { ...slot.body, data: slot.coreData }
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
    if (slot.evidence()) this.emit(path, slot)
  }

  beat(now: number): void {
    for (const [path, slot] of this.slots) {
      if (now - slot.lastBeat < HEARTBEAT_S) continue
      slot.lastBeat = now
      if (slot.evidence()) this.emit(path, slot)
    }
  }

  status(path: string): AlertStatus | undefined {
    const slot = this.slots.get(path)
    if (slot !== undefined) {
      const message = slot.sent ?? slot.render(limitIn(slot.coreData))
      return { awaitingInput: !slot.evidence(), message }
    }
    const latched = this.latched.get(path)
    return latched === undefined ? undefined : { awaitingInput: false, message: latched }
  }

  private emit(path: string, slot: Slot): void {
    slot.unsent = false
    slot.sent = slot.render(limitIn(slot.coreData))
    this.deps.send(path, { ...slot.body, message: slot.sent })
  }
}
