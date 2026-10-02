import { describe, expect, it } from 'vitest'
import type { EditPreview } from '../../../src/panel/api'
import { editConsequences } from '../../../src/panel/editor/consequences'

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

  it('names a switch between steps and a zone limit', () => {
    const [line] = editConsequences(
      preview({
        restarts: true,
        changes: ['detector.limit'],
        activeAlerts: 1,
        clearsActiveAlert: true
      }),
      []
    )
    expect(line).toContain('because its limit kind changed.')
  })

  it('names a moved alert path in words', () => {
    const [line] = editConsequences(
      preview({
        restarts: true,
        changes: ['alertPath', 'detector.direction'],
        activeAlerts: 1,
        clearsActiveAlert: true
      }),
      []
    )
    expect(line).toContain('because its alert path and direction changed.')
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
