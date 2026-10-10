/**
 * How many digits a number keeps, and which unit a duration is shown in,
 * shared by the webapp and the alert messages the plugin renders.
 */

// Below the float noise of a unit conversion (95 °C is 368.15 K, stored as
// 368.149999…), so a half the user wrote rounds as written.
const SIGNIFICANT = 12

const denoise = (value: number): number => Number(value.toPrecision(SIGNIFICANT))

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  const magnitude = Math.abs(value)
  const decimals = magnitude >= 100 ? 1 : 3 - Math.floor(Math.log10(magnitude))
  const scale = 10 ** decimals
  return String((Math.sign(value) * Math.round(denoise(denoise(magnitude) * scale))) / scale)
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
