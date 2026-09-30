import { describe, expect, it } from 'vitest'
import type { EditPreview } from '../../../src/panel/api'
import { discardedTotals, editConsequences } from '../../../src/panel/editor/consequences'
import { formatDuration } from '../../../src/panel/rules/describe'
import { instance, ruleEntry } from '../fixtures'

const preview = (overrides: Partial<EditPreview>): EditPreview => ({
  restarts: false,
  changes: [],
  activeAlerts: 0,
  clearsActiveAlert: false,
  discardsTotal: false,
  ...overrides
})

describe('editConsequences', () => {
  it('asks nothing for an edit applied in place', () => {
    expect(editConsequences(preview({ activeAlerts: 1 }), [])).toEqual([])
  })

  it('names the cleared alert and what made the rule restart', () => {
    const lines = editConsequences(
      preview({
        restarts: true,
        changes: ['signal', 'detector.limit.level'],
        activeAlerts: 1,
        clearsActiveAlert: true
      }),
      []
    )
    expect(lines).toEqual([
      'Saving clears the active alert of this rule and restarts it, because its input and zone level changed. It raises again once its condition holds.'
    ])
  })

  it('counts several cleared alerts', () => {
    const [line] = editConsequences(
      preview({ restarts: true, changes: ['gates'], activeAlerts: 3, clearsActiveAlert: true }),
      []
    )
    expect(line).toMatch(/^Saving clears 3 active alerts of this rule/)
  })

  it('names the totals an edit discards', () => {
    expect(editConsequences(preview({ discardsTotal: true }), ['port: 2 h', 'stbd: 1 h'])).toEqual([
      'Saving discards the accumulated totals port: 2 h, stbd: 1 h.'
    ])
    expect(editConsequences(preview({ discardsTotal: true }), [])).toEqual([
      'Saving discards the accumulated total.'
    ])
  })
})

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
    expect(discardedTotals(entry, formatDuration)).toEqual(['port: 2 h'])
    const single = ruleEntry({
      status: { instances: [instance({ progress: { kind: 'total', total: 60, limit: 90 } })] }
    })
    expect(discardedTotals(single, formatDuration)).toEqual(['60 s'])
  })
})
