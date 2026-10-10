import { describe, it, expect } from 'vitest'
import { formatDuration, formatNumber } from '../src/format.js'

describe('formatNumber', () => {
  it('keeps one decimal from 100 up and four significant digits below', () => {
    expect(formatNumber(1234.56)).toBe('1234.6')
    expect(formatNumber(13.3141)).toBe('13.31')
    expect(formatNumber(0.036712)).toBe('0.03671')
    expect(formatNumber(50.4)).toBe('50.4')
    expect(formatNumber(12)).toBe('12')
  })

  it('rounds a written half away from zero, as the user wrote it', () => {
    // 95 °C and 90 °C in K, stored just below their written .x5
    expect(formatNumber(368.15)).toBe('368.2')
    expect(formatNumber(363.15)).toBe('363.2')
    expect(formatNumber(-60 + 273.15)).toBe('213.2')
    expect(formatNumber(-368.15)).toBe('-368.2')
    expect(formatNumber(1.0005)).toBe('1.001')
    expect(formatNumber(-12.345)).toBe('-12.35')
    expect(formatNumber(1234.55)).toBe('1234.6')
  })

  it('carries into the next digit without trailing zeros', () => {
    expect(formatNumber(99.995)).toBe('100')
    expect(formatNumber(0.1 + 0.2)).toBe('0.3')
  })

  it('keeps very small and very large values readable', () => {
    expect(formatNumber(1.23456e-9)).toBe('1.235e-9')
    expect(formatNumber(2.5e21)).toBe('2.5e+21')
  })
})

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
