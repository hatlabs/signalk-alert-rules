import type {
  Context,
  Path,
  PathValue,
  SubscriptionManager,
  Unsubscribes
} from '@signalk/server-api'
import { wildcards } from '../alerts/paths.js'
import { resolvePointer, splitPointerPath } from '../model/pointerPath.js'
import { MAX_INSTANCES, type PathInput, type Signal } from '../model/rule.js'
import { combine } from './combinators.js'
import { InstanceRegistry, instanceIn } from './instances.js'
import { asGiven, type Canonicalise } from './sourceRefs.js'

export interface Position {
  latitude: number
  longitude: number
}

export type SignalValue = number | string | boolean | Position

/**
 * A signal's state after a sample. Unavailable covers both a null value and
 * the server's timed-out marker; `timedOut` tells them apart for timeout rules.
 * A signal that has never produced a sample is never seen, which is the
 * absence of any reading rather than a reading.
 */
export type Reading =
  { available: true; value: SignalValue } | { available: false; timedOut: boolean }

/** Whether an input has a value, is unavailable, or has never been seen since start. */
export type InputState = 'value' | 'unavailable' | 'neverSeen'

export function inputState(reading: Reading | undefined): InputState {
  if (reading === undefined) return 'neverSeen'
  return reading.available ? 'value' : 'unavailable'
}

export interface Instance {
  /** The path segment the rule's wildcard matched. */
  name: string
  /** `name` made safe to append to an alert path. */
  segment: string
}

/**
 * The Signal K path an input reads and the tokens of the field it addresses
 * in that path's value; no tokens for the whole value. Rules reach the
 * engine validated, so an invalid pointer is not expected here.
 */
function fieldOf(path: string): { basePath: string; tokens: readonly string[] } {
  const split = splitPointerPath(path)
  return { basePath: split.basePath, tokens: split.valid ? split.tokens : [] }
}

/** A path with its wildcard segment replaced by the instance's name. */
export function bindPath(path: string, instance: Instance | undefined): string {
  if (instance === undefined) return path
  const { basePath } = fieldOf(path)
  const bound = basePath
    .split('.')
    .map((s) => (s === '*' ? instance.name : s))
    .join('.')
  return bound + path.slice(basePath.length)
}

export interface Sample {
  /** Set for a wildcard signal only. */
  instance?: Instance
  reading: Reading
  /**
   * The value was already in the server's delta cache when the signal was
   * opened, so it is not a new event.
   */
  replayed: boolean
}

export interface SignalHandlers {
  onSample: (sample: Sample) => void
  /** A condition the rule's status should show, such as a rejected instance. */
  onIssue: (message: string) => void
  onError: (err: unknown) => void
}

const SELF = 'vessels.self' as Context
const UNAVAILABLE: Reading = { available: false, timedOut: false }

function isPosition(value: object): value is Position {
  const { latitude, longitude } = value as Record<string, unknown>
  return (
    typeof latitude === 'number' &&
    Number.isFinite(latitude) &&
    typeof longitude === 'number' &&
    Number.isFinite(longitude)
  )
}

function toReading(pv: PathValue, tokens: readonly string[]): Reading {
  const value = pv.value === null ? null : resolvePointer(pv.value, tokens)
  if (value === undefined) return UNAVAILABLE
  if (value === null) return { available: false, timedOut: pv.state?.timedOut === true }
  if (typeof value === 'number')
    return Number.isFinite(value) ? { available: true, value } : UNAVAILABLE
  if (typeof value === 'string' || typeof value === 'boolean') return { available: true, value }
  if (typeof value === 'object' && isPosition(value)) {
    return { available: true, value: { latitude: value.latitude, longitude: value.longitude } }
  }
  return UNAVAILABLE
}

/** A value of the base path the input reads, from a source it accepts. */
type OnValue = (pv: PathValue, replayed: boolean) => void

interface Subscriptions {
  manager: SubscriptionManager
  canonical: Canonicalise
}

function subscribeInput(
  input: PathInput,
  { manager, canonical }: Subscriptions,
  onError: (err: unknown) => void,
  onValue: OnValue
): Unsubscribes {
  const { source } = input
  const { basePath } = fieldOf(input.path)
  // Deltas carry the provider's form of a ref, which for an NMEA 2000 device
  // may be its bus address rather than its CAN name.
  const accepts = (ref: string | undefined) =>
    source === undefined ||
    ref === source ||
    (ref !== undefined && canonical(ref) === canonical(source))
  const unsubscribes: Unsubscribes = []
  // The server replays its cached values synchronously inside subscribe().
  let replaying = true
  manager.subscribe(
    {
      context: SELF,
      subscribe: [{ path: basePath as Path }],
      // The preferred-source bus never carries a lower-ranked source's values.
      sourcePolicy: input.source === undefined ? 'preferred' : 'all'
    },
    unsubscribes,
    onError,
    (delta) => {
      for (const update of delta.updates) {
        if (!('values' in update)) continue
        if (!accepts(update.$source)) continue
        for (const pv of update.values) onValue(pv, replaying)
      }
    }
  )
  replaying = false
  return unsubscribes
}

function openPath(
  input: PathInput,
  subscriptions: Subscriptions,
  handlers: SignalHandlers
): Unsubscribes {
  const { basePath, tokens } = fieldOf(input.path)
  if (wildcards(basePath) === 0) {
    return subscribeInput(input, subscriptions, handlers.onError, (pv, replayed) => {
      if (pv.path === basePath) handlers.onSample({ reading: toReading(pv, tokens), replayed })
    })
  }
  const registry = new InstanceRegistry()
  // Bounded like the admitted set: every distinct matching path would otherwise add a name.
  const reported = new Set<string>()
  return subscribeInput(input, subscriptions, handlers.onError, (pv, replayed) => {
    const name = instanceIn(basePath, pv.path)
    if (name === undefined) return
    const admission = registry.admit(name)
    if (admission.ok) {
      const instance = { name, segment: admission.segment }
      handlers.onSample({ instance, reading: toReading(pv, tokens), replayed })
    } else if (reported.size < MAX_INSTANCES && !reported.has(name)) {
      reported.add(name)
      handlers.onIssue(admission.reason)
    }
  })
}

function openCombinator(
  signal: Extract<Signal, { combinator: unknown }>,
  subscriptions: Subscriptions,
  handlers: SignalHandlers
): Unsubscribes {
  const latest: (Reading | undefined)[] = signal.inputs.map(() => undefined)
  const angular = signal.angular === true

  function combined(): Reading | undefined {
    const values = []
    let timedOut: boolean | undefined
    for (const reading of latest) {
      if (reading === undefined) return undefined
      if (reading.available) values.push(reading.value)
      else timedOut = timedOut === true || reading.timedOut
    }
    if (timedOut !== undefined) return { available: false, timedOut }
    return combine(signal.combinator, values, angular)
  }

  // Fields of one path arrive in one delta: read apart, the first field's
  // update would combine with the other field's previous value.
  const shared = new Map<string, number[]>()
  signal.inputs.forEach((input, i) => {
    const key = JSON.stringify([fieldOf(input.path).basePath, input.source ?? null])
    const indices = shared.get(key)
    if (indices === undefined) shared.set(key, [i])
    else indices.push(i)
  })

  return [...shared.values()].flatMap((indices) => {
    const fields = indices.map((i) => ({ i, ...fieldOf(signal.inputs[i].path) }))
    const { basePath } = fields[0]
    return subscribeInput(
      signal.inputs[indices[0]],
      subscriptions,
      handlers.onError,
      (pv, replayed) => {
        if (pv.path !== basePath) return
        for (const { i, tokens } of fields) latest[i] = toReading(pv, tokens)
        const result = combined()
        if (result !== undefined) handlers.onSample({ reading: result, replayed })
      }
    )
  })
}

/**
 * Subscribes to a rule signal on the self vessel and reports each change as a
 * sample. A pinned source matches a delta whose `$source` has the same
 * canonical form. Returns a function that ends every subscription it opened.
 */
export function openSignal(
  signal: Signal,
  manager: SubscriptionManager,
  handlers: SignalHandlers,
  canonical: Canonicalise = asGiven
): () => void {
  const subscriptions = { manager, canonical }
  const unsubscribes =
    'combinator' in signal
      ? openCombinator(signal, subscriptions, handlers)
      : openPath(signal, subscriptions, handlers)
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe()
  }
}
