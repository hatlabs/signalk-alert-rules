/** The segment under which every SKAR alert path lives, below `alerts.`. */
export const RULES_PREFIX = 'rules'

const DELTA_PREFIX = 'alerts.'
// `rules.<origin>.<slug>`, and one more segment for a wildcard instance.
const RULE_SEGMENTS = 3
const INSTANCE_SEGMENTS = RULE_SEGMENTS + 1

export interface ParsedAlertPath {
  ruleId: string
  /** The instance segment of a wildcard rule's alert. */
  segment?: string
}

/** Identifies a rule across the store, the runner and alert paths. */
export function ruleId(origin: string, slug: string): string {
  return `${origin}.${slug}`
}

/** Splits a core alert path (without `alerts.`) of the form `rules.<origin>.<slug>[.<instance>]`. */
export function parseAlertPath(path: string): ParsedAlertPath | undefined {
  const segments = path.split('.')
  if (
    segments[0] !== RULES_PREFIX ||
    segments.length < RULE_SEGMENTS ||
    segments.length > INSTANCE_SEGMENTS
  ) {
    return undefined
  }
  const [, origin, slug, segment] = segments
  const id = ruleId(origin, slug)
  return segments.length === INSTANCE_SEGMENTS ? { ruleId: id, segment } : { ruleId: id }
}

/** The delta path that raises or clears the alert at a core alert path. */
export function deltaPath(path: string): string {
  return DELTA_PREFIX + path
}
