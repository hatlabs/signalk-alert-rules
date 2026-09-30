import { describe, expect, it } from 'vitest'
import { discardedTotals, formatDuration } from '../../../src/panel/rules/describe'
import { instance, ruleEntry } from '../fixtures'

describe('discardedTotals', () => {
  it('lists each instance total above zero, named for a wildcard rule', () => {
    const entry = ruleEntry({
      status: {
        instances: [
          instance({
            instance: { name: 'port', segment: 'port' },
            progress: { kind: 'total', total: 7200, limit: 9000 }
          }),
          instance({
            instance: { name: 'stbd', segment: 'stbd' },
            progress: { kind: 'total', total: 0, limit: 9000 }
          })
        ]
      }
    })
    expect(discardedTotals(entry, formatDuration)).toEqual([{ name: 'port', total: '2 h' }])
    const single = ruleEntry({
      status: { instances: [instance({ progress: { kind: 'total', total: 60, limit: 90 } })] }
    })
    expect(discardedTotals(single, formatDuration)).toEqual([{ name: '', total: '60 s' }])
  })
})
