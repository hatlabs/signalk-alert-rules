/**
 * How many digits a number keeps, and which unit a duration is shown in,
 * shared by the webapp and the alert messages the plugin renders.
 */

export function formatNumber(value: number): string {
  const rounded = Math.abs(value) >= 100 ? value.toFixed(1) : value.toPrecision(4)
  return Number.isInteger(value) ? String(value) : String(Number(rounded))
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
