/**
 * How many digits a number keeps, and which unit a duration is shown in,
 * shared by the webapp and the alert messages the plugin renders.
 */

const LARGE = 100
const DECIMALS_FROM_LARGE = 1
const SIGNIFICANT_BELOW_LARGE = 4

// Float noise sits far below the kept digit (368.15, 95 °C in K, is the double
// 368.149999…), so cutting it there lets a half the user wrote round as written.
const NOISE_DECIMALS = 6

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  const magnitude = Math.abs(value)
  const decimals =
    magnitude >= LARGE
      ? DECIMALS_FROM_LARGE
      : SIGNIFICANT_BELOW_LARGE - 1 - Math.floor(Math.log10(magnitude))
  const scale = 10 ** decimals
  const kept = Math.round(Number((magnitude * scale).toFixed(NOISE_DECIMALS)))
  return String((Math.sign(value) * kept) / scale)
}

const MINUTE = 60
const HOUR = 3600

/** Seconds in the largest unit that keeps the number readable: timers and running time. */
export function formatDuration(seconds: number): string {
  if (Math.abs(seconds) >= 2 * HOUR) return `${formatNumber(seconds / HOUR)} h`
  if (Math.abs(seconds) >= 2 * MINUTE) return `${formatNumber(seconds / MINUTE)} min`
  // A timer's elapsed time comes in fractions no operator needs.
  return `${String(Math.round(seconds))} s`
}
