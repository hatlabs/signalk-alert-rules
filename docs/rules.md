# Rules

## Zone limits

A zone limit takes a rule's threshold from the `meta.zones` of a path instead of a fixed value. It names the least severe zone level the rule watches: `alert`, `warn`, `alarm` or `emergency`. The rule covers that level and every more severe level the zones define. Zones in `normal`, `nominal` or any other state raise nothing and give no threshold.

### The rule's side

A path can have zones on both sides of its normal range, such as a battery voltage with a low alarm and a high alarm. A zone limit only uses the zones on the rule's direction side: the low side for a `below` rule (and a falling projection), the high side for an `above` rule (and a rising projection).

Each zone is placed on a side as follows. A missing or `null` bound counts as no bound.

- A zone with no lower bound is on the low side.
- A zone with no upper bound is on the high side.
- A zone bounded on both sides is placed against the normal range, which runs from the lowest lower bound to the highest upper bound of all `normal` and `nominal` zones together. It is on the low side when its upper bound is at or below the bottom of that range, and on the high side when its lower bound is at or above the top. A zone that overlaps the range has no side. Because the range spans every normal and nominal zone, a zone in a gap between two normal zones overlaps it.
- On a path with no `normal` or `nominal` zone, a zone bounded on both sides takes the side of the path's one-sided zones when all of them lie on the same side, as on a coolant temperature path zoned only above. When the one-sided zones lie on both sides, or there are none, the zone has no side. Without a normal zone this cannot tell a two-sided path whose zones on one side are all bounded on both sides from a one-sided path: with `{ upper: 11.5, state: 'alarm' }` and `{ lower: 14.8, upper: 20, state: 'alarm' }`, the high zone is placed on the low side. Adding a normal zone between them places it correctly.
- A zone with neither bound has no side.

### Threshold

The threshold of a level is the edge of the union of that level's zones and every more severe zone on the rule's side, at the end the condition enters from: the highest upper bound for a low-side rule, the lowest lower bound for a high-side rule. A sustained rule resolves each more severe level the same way and escalates its alert as the value enters it.

For example, with zones `{ upper: 11.5, state: 'alarm' }`, `{ lower: 11.5, upper: 12, state: 'warn' }`, `{ lower: 12, upper: 14.4, state: 'normal' }` and `{ lower: 14.8, state: 'alarm' }`, a `below` rule naming `warn` has threshold 12 and escalates to alarm below 11.5, and an `above` rule naming `alarm` has threshold 14.8.

### When a zone limit does not resolve

The rule is inactive, with one of these reasons, when:

- a zone at or above the named level has no side: "the side of the `<level>` zone from `<lower>` to `<upper>` cannot be told; add a normal zone that separates the low zones from the high ones". A zone of the named level or a more severe one could move the threshold whichever side it is on, so it blocks the rule. Zones less severe than the named level are not checked.
- a zone at or above the named level has neither bound: "the `<level>` zone has neither bound, so its side cannot be told".
- the rule's side has no zone of the named level: "the path has no `<level>` zone on the `<low|high>` side". A more severe zone does not stand in for a missing named level.

A more severe level that does not resolve is left out of escalation.
