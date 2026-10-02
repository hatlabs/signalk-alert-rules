import { describe, expect, it } from 'vitest'
import type { ListedRule } from '../../../src/panel/api'
import { byAttention, chipOf, needsAttention, summary } from '../../../src/panel/list/attention'
import { invalidEntry, ruleEntry } from '../fixtures'

const at = (minute: number) => `2026-09-30T12:${String(minute).padStart(2, '0')}:00.000Z`

function rule(slug: string, condition: ListedRule['status']['condition'], minute: number) {
  return ruleEntry({ slug, status: { condition, changedAt: at(minute) } })
}

function disabled(slug: string, minute: number) {
  return ruleEntry({
    slug,
    disabled: { since: at(minute), actor: 'admin' },
    status: { ruleState: 'disabled', condition: 'present', changedAt: at(minute) }
  })
}

describe('chipOf', () => {
  it('is Disabled for a disabled rule whatever its condition, else the condition', () => {
    expect(chipOf(disabled('a', 1))).toBe('disabled')
    expect(chipOf(rule('a', 'noData', 1))).toBe('noData')
    expect(chipOf(invalidEntry())).toBe('problem')
  })
})

describe('byAttention', () => {
  it('orders alerting, problem, no data, disabled, then normal', () => {
    const rules = [
      rule('normal', 'normal', 9),
      disabled('disabled', 9),
      rule('nodata', 'noData', 1),
      invalidEntry({ slug: 'invalid' }),
      rule('alerting', 'alerting', 1)
    ]
    expect(byAttention(rules).map((r) => r.slug)).toEqual([
      'alerting',
      'invalid',
      'nodata',
      'disabled',
      'normal'
    ])
  })

  it('puts the most recent change first within a state', () => {
    const rules = [
      rule('old', 'alerting', 1),
      rule('new', 'alerting', 30),
      rule('mid', 'alerting', 9)
    ]
    expect(byAttention(rules).map((r) => r.slug)).toEqual(['new', 'mid', 'old'])
  })

  it('keeps the server order between equal changes, and leaves its input alone', () => {
    const rules = [rule('b', 'normal', 1), rule('a', 'normal', 1)]
    expect(byAttention(rules).map((r) => r.slug)).toEqual(['b', 'a'])
    expect(rules.map((r) => r.slug)).toEqual(['b', 'a'])
  })
})

describe('needsAttention', () => {
  it('is every state but normal', () => {
    expect(needsAttention(rule('a', 'normal', 1))).toBe(false)
    expect(needsAttention(rule('a', 'noData', 1))).toBe(true)
    expect(needsAttention(disabled('a', 1))).toBe(true)
  })
})

describe('summary', () => {
  it('counts the rules per state in attention order, leaving out states no rule has', () => {
    const rules = [
      rule('a', 'normal', 1),
      rule('b', 'normal', 1),
      rule('c', 'alerting', 1),
      disabled('d', 1),
      invalidEntry()
    ]
    expect(summary(rules)).toBe('1 alerting · 1 problem · 1 disabled · 2 normal')
  })

  it('says no data in words', () => {
    expect(summary([rule('a', 'noData', 1)])).toBe('1 no data')
  })
})
