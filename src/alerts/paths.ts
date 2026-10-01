/** The segment under which every SKAR alert path lives, below `alerts.`. */
export const RULES_PREFIX = 'rules'

const DELTA_PREFIX = 'alerts.'
// `rules.<slug>`, and one more segment for a wildcard instance.
const RULE_SEGMENTS = 2
const INSTANCE_SEGMENTS = RULE_SEGMENTS + 1

export interface ParsedAlertPath {
  /** The rule's slug, which identifies it across the store, the runner and alert paths. */
  slug: string
  /** The instance segment of a wildcard rule's alert. */
  segment?: string
}

/** Splits a core alert path (without `alerts.`) of the form `rules.<slug>[.<instance>]`. */
export function parseAlertPath(path: string): ParsedAlertPath | undefined {
  const segments = path.split('.')
  if (
    segments[0] !== RULES_PREFIX ||
    segments.length < RULE_SEGMENTS ||
    segments.length > INSTANCE_SEGMENTS
  ) {
    return undefined
  }
  const [, slug, segment] = segments
  return segments.length === INSTANCE_SEGMENTS ? { slug, segment } : { slug }
}

/** The delta path that raises or clears the alert at a core alert path. */
export function deltaPath(path: string): string {
  return DELTA_PREFIX + path
}
