import type {
  Context,
  Path,
  PathValue,
  SubscriptionManager,
  Unsubscribes
} from '@signalk/server-api'
import { MAX_INSTANCES, type PathInput, type Signal } from '../model/rule.js'
import { combine } from './combinators.js'
import { InstanceRegistry, instanceIn } from './instances.js'
import type { Canonicalise } from './sourceRefs.js'

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

/** A path with its wildcard segment replaced by the instance's name. */
export function bindPath(path: string, instance: Instance | undefined): string {
  if (instance === undefined) return path
  return path
    .split('.')
    .map((s) => (s === '*' ? instance.name : s))
    .join('.')
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

function toReading(pv: PathValue): Reading {
  const { value } = pv
  if (value === null) return { available: false, timedOut: pv.state?.timedOut === true }
  if (typeof value === 'number')
    return Number.isFinite(value) ? { available: true, value } : UNAVAILABLE
  if (typeof value === 'string' || typeof value === 'boolean') return { available: true, value }
  if (typeof value === 'object' && isPosition(value)) {
    return { available: true, value: { latitude: value.latitude, longitude: value.longitude } }
  }
  return UNAVAILABLE
}

type OnValue = (path: string, reading: Reading, replayed: boolean) => void

const asGiven: Canonicalise = (ref) => ref

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
      subscribe: [{ path: input.path as Path }],
      // The preferred-source bus never carries a lower-ranked source's values.
      sourcePolicy: input.source === undefined ? 'preferred' : 'all'
    },
    unsubscribes,
    onError,
    (delta) => {
      for (const update of delta.updates) {
        if (!('values' in update)) continue
        if (!accepts(update.$source)) continue
        for (const pv of update.values) onValue(pv.path, toReading(pv), replaying)
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
  if (!input.path.split('.').includes('*')) {
    return subscribeInput(input, subscriptions, handlers.onError, (path, reading, replayed) => {
      if (path === input.path) handlers.onSample({ reading, replayed })
    })
  }
  const registry = new InstanceRegistry()
  // Bounded like the admitted set: every distinct matching path would otherwise add a name.
  const reported = new Set<string>()
  return subscribeInput(input, subscriptions, handlers.onError, (path, reading, replayed) => {
    const name = instanceIn(input.path, path)
    if (name === undefined) return
    const admission = registry.admit(name)
    if (admission.ok) {
      handlers.onSample({ instance: { name, segment: admission.segment }, reading, replayed })
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

  return signal.inputs.flatMap((input, i) =>
    subscribeInput(input, subscriptions, handlers.onError, (path, reading, replayed) => {
      if (path !== input.path) return
      latest[i] = reading
      const result = combined()
      if (result !== undefined) handlers.onSample({ reading: result, replayed })
    })
  )
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
