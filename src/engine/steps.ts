import type { Detector } from '../model/rule.js'
import type { DetectorSpec } from './detectors/index.js'

/**
 * The detector of a rule's step `i`, for a rule with typed steps; undefined
 * for a step the rule does not have.
 */
export function stepSpec(d: Detector, i: number): DetectorSpec | undefined {
  switch (d.type) {
    case 'match': {
      const { steps, ...rest } = d
      if (i >= steps.length) return undefined
      const values = steps.slice(i).flatMap((s) => (s.value === undefined ? [] : [s.value]))
      return { ...rest, values }
    }
    case 'sustained':
    case 'projection': {
      const { steps, limit: _zone, ...rest } = d
      const step = steps?.at(i)
      return step === undefined ? undefined : { ...rest, limit: step.limit }
    }
    case 'slope':
    case 'accumulator':
    case 'count': {
      const { steps, ...rest } = d
      const step = steps.at(i)
      return step === undefined ? undefined : { ...rest, limit: step.limit }
    }
    case 'absence': {
      const { steps, ...rest } = d
      const step = steps.at(i)
      return step === undefined ? undefined : { ...rest, within: step.within }
    }
    case 'outside':
      throw new Error('outside detector not implemented')
  }
}
