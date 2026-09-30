# Rules

## Zone limits

A zone limit takes a rule's threshold from the `meta.zones` of a path instead of a fixed value. It names the least severe zone level the rule watches: `alert`, `warn`, `alarm` or `emergency`. The rule covers that level and every more severe level the zones define. Zones in `normal`, `nominal` or any other state raise nothing, give no threshold and play no part in resolving one.

### Runs

A zone limit works on runs. Take the zones in the named level or a more severe one, and ignore all others. A missing or `null` bound is open, so a zone with no lower bound reaches down without end and one with no upper bound reaches up without end. Sort the zones by lower bound and merge each zone that touches or overlaps the run before it (its lower bound is at or below that run's upper bound) into that run. What remains are the runs: stretches of the range where the value is at the named level or worse, separated by gaps.

### Threshold

A path can have zones on both sides of its range, such as a battery voltage with a low alarm and a high alarm. The rule's side is the low side for a `below` rule (and a falling projection) and the high side for an `above` rule (and a rising projection). The outermost run on that side is the one the rule watches, and no normal zone is needed to tell the sides apart:

- For `below`, the lowest run. The threshold is its upper edge.
- For `above`, the highest run. The threshold is its lower edge.

That edge must be a bound, not open, and only zones of the named level may supply it: a zone supplies the edge when its upper bound is the edge for `below`, its lower bound for `above`. A run graded from the named level outward has the named level alone at its inner edge and the more severe levels beyond it. On a path zoned on one side only, the outermost run on the unzoned side is the other side's run, with a more severe level at the edge the rule would take, whether that level's zone is adjacent to the named level's or nested inside it and sharing its outer bound (`{ lower: 0.8, upper: 1, state: 'warn' }` with `{ lower: 0.9, upper: 1, state: 'alarm' }`). Taking that edge would put the whole range past the threshold and the rule would alert permanently, so the rule is inactive instead.

For example, with zones `{ upper: 11.5, state: 'alarm' }`, `{ lower: 11.5, upper: 12, state: 'warn' }`, `{ lower: 12, upper: 14.4, state: 'normal' }` and `{ lower: 14.8, state: 'alarm' }`, a `below` rule naming `warn` has threshold 12 and an `above` rule naming `alarm` has threshold 14.8. A path zoned on one side only resolves the same way whether or not its zones are open-ended: engine revolutions zoned `{ lower: 3200, upper: 3600, state: 'warn' }` and `{ lower: 3600, upper: 4000, state: 'alarm' }` give an `above` rule naming `warn` the threshold 3200, while a `below` rule naming `warn` on the same zones does not resolve, because the upper edge of the only run, 4000, comes from the alarm zone.

### Escalation

A sustained rule resolves each more severe level the zones define the same way, and escalates its alert as the value passes that level's threshold. A more severe level is an escalation step only when its threshold is at or beyond the named level's threshold in the rule's direction: at or below it for `below`, at or above it for `above`. A more severe level whose only zones lie on the far side of the range resolves to a threshold short of the named level's, so it is left out. With `{ upper: 12, state: 'warn' }` and `{ lower: 14.8, upper: 20, state: 'alarm' }`, a `below` rule naming `warn` has threshold 12 and no escalation step, because alarm resolves to 20 on its own.

A more severe level that does not resolve is left out of escalation too.

### When a zone limit does not resolve

The rule is inactive, with one of these reasons, when:

- the path has no zone of the named level at all: "the path has no `<level>` zone". A more severe zone does not stand in for a missing named level.
- the edge of the outermost run on the rule's side is open, or no zone of the named level supplies it: "the path has no `<level>` zone on the `<low|high>` side". This covers a named level defined only on the other side, a rule pointing at the unzoned side of a path zoned on one side only, and a zone at or above the named level with neither bound, which merges everything into one run open at both ends.

### Known limitations

- Zones on the same side separated by a gap make the rule inactive. With `{ lower: 3200, upper: 3600, state: 'warn' }` and `{ lower: 3800, upper: 4000, state: 'alarm' }`, the highest run is the alarm zone alone, so an `above` rule naming `warn` reports "the path has no warn zone on the high side". Make the zones touch for the rule to resolve.
- A side lacking the named level makes the rule inactive, even when the other side's zones of that level are bounded on both sides and could be read as lying on the rule's side. With `{ upper: 11.5, state: 'alarm' }` and `{ lower: 14.8, upper: 20, state: 'warn' }`, a `below` rule naming `warn` reports "the path has no warn zone on the low side".
- A path with a single bounded zone, or with bounded zones all of one level, resolves in either direction, since zones of the named level supply the edges on both sides. With `{ lower: 0, upper: 5, state: 'alarm' }`, a `below` rule naming `alarm` has threshold 5 and an `above` rule naming `alarm` has threshold 0. A rule pointing the wrong way on such a path alerts permanently.
