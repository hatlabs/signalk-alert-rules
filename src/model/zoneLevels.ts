/**
 * The `meta.zones` states that raise an alert, and the priority each raises
 * at; normal and nominal raise nothing. Kept apart from the rule schema so
 * the webapp can resolve a zone limit as the server does without bundling
 * its schemas.
 */
import type { Priority } from './rule.js'

export const ZONE_LEVELS = ['alert', 'warn', 'alarm', 'emergency'] as const
export type ZoneLevel = (typeof ZONE_LEVELS)[number]

/** The priority a zone-limit rule raises at while a zone level is the most severe it holds. */
export const LEVEL_PRIORITY: Readonly<Record<ZoneLevel, Priority>> = {
  alert: 'caution',
  warn: 'warning',
  alarm: 'alarm',
  emergency: 'emergency'
}
