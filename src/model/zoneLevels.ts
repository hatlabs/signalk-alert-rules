/**
 * The zone levels, kept apart from the rule schema so the webapp can resolve
 * a zone limit as the server does without bundling its schemas.
 */
/** The `meta.zones` states that raise an alert; normal and nominal raise nothing. */
export const ZONE_LEVELS = ['alert', 'warn', 'alarm', 'emergency'] as const
export type ZoneLevel = (typeof ZONE_LEVELS)[number]
