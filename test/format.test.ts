import { describe, it, expect } from 'vitest'
import { formatDuration } from '../src/format.js'

describe('formatDuration', () => {
  it('uses seconds, minutes or hours by size', () => {
    expect(formatDuration(20)).toBe('20 s')
    expect(formatDuration(119)).toBe('119 s')
    expect(formatDuration(150)).toBe('2.5 min')
    expect(formatDuration(7200)).toBe('2 h')
    expect(formatDuration(900000)).toBe('250 h')
  })

  it('shows seconds whole, as a timer has run them', () => {
    expect(formatDuration(0.0367)).toBe('0 s')
    expect(formatDuration(43.05)).toBe('43 s')
    expect(formatDuration(59.6)).toBe('60 s')
  })
})
