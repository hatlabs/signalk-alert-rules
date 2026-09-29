import { AbsenceDetector } from './absence.js'
import { AccumulatorDetector } from './accumulator.js'
import { CountDetector } from './count.js'
import type { Detector, DetectorOptions, DetectorSpec } from './detector.js'
import { MatchDetector } from './match.js'
import { ProjectionDetector, SlopeDetector } from './slope.js'
import { SustainedDetector } from './sustained.js'

export type { Detector, DetectorOptions, DetectorSpec, Transition } from './detector.js'
export { AccumulatorDetector }

export function createDetector(spec: DetectorSpec, options: DetectorOptions): Detector {
  switch (spec.type) {
    case 'match':
      return new MatchDetector(spec, options)
    case 'sustained':
      return new SustainedDetector(spec, options)
    case 'slope':
      return new SlopeDetector(spec, options)
    case 'projection':
      return new ProjectionDetector(spec, options)
    case 'accumulator':
      return new AccumulatorDetector(spec, options)
    case 'count':
      return new CountDetector(spec, options)
    case 'absence':
      return new AbsenceDetector(spec, options)
  }
}
