import {
  AccumulatorDetector,
  createDetector,
  SustainedDetector,
  type Detector,
  type DetectorOptions,
  type DetectorSpec,
  type Transition
} from '../../../src/engine/detectors/index.js'
import type { Reading, SignalValue } from '../../../src/engine/signals.js'

export const UNAVAILABLE: Reading = { available: false, timedOut: false }
export const TIMED_OUT: Reading = { available: false, timedOut: true }

export function v(value: SignalValue): Reading {
  return { available: true, value }
}

type DetectorFor<S extends DetectorSpec> = S extends { type: 'accumulator' }
  ? AccumulatorDetector
  : S extends { type: 'sustained' | 'outside' }
    ? SustainedDetector
    : Detector

/**
 * Drives a detector on a hand-set monotonic clock. `at(t, reading)` delivers a
 * sample at `t` seconds, `at(t)` only lets time pass.
 */
export function harness<S extends DetectorSpec>(spec: S, options: Partial<DetectorOptions> = {}) {
  // createDetector builds an AccumulatorDetector exactly for an accumulator spec.
  const detector = createDetector(spec, { start: 0, ...options }) as DetectorFor<S>
  const log: [number, Transition][] = []
  function at(t: number, reading?: Reading, replayed = false): Transition | undefined {
    const transition =
      reading === undefined ? detector.tick(t) : detector.sample(reading, replayed, t)
    if (transition !== undefined) log.push([t, transition])
    return transition
  }
  return { detector, log, at }
}
