/**
 * The validator's messages for an outside rule's ranges, which the webapp
 * matches to reword them. Kept apart from the validator so the webapp can
 * import them without bundling its schemas.
 */
/** A range step whose high limit is not above its low. */
export const RANGE_INVERTED = 'must be above the low limit'
/** A later range step narrower than the previous one on a side, or no wider. */
export const RANGE_NOT_WIDER = "must not be inside the previous step's range"
/** An outside rule's hysteresis of half its first step's width or more. */
export const RANGE_HYSTERESIS =
  "must be less than half the first step's range, or the alert could never clear"
