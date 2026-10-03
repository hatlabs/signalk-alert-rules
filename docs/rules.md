# Rules

This is the reference for the Alert Rules rule model: what a rule consists of, how it is evaluated, and what it sends to the Signal K alerts API. Field names are those of the rule schema in `src/model/rule.ts`. Every number in a rule is in SI units.

The rules in [`examples/rules`](../examples/rules) are complete, valid rules; [Worked examples](#worked-examples) shows what each one raises and clears.

## Rule

```json
{
  "name": "Coolant temperature rising",
  "slug": "coolant-temperature-rising",
  "message": "Coolant temperature is rising fast on {instance}",
  "signal": { "path": "propulsion.*.coolantTemperature" },
  "detector": {
    "type": "slope",
    "direction": "rising",
    "window": 300,
    "steps": [{ "limit": 0.02, "priority": "warning" }]
  },
  "gates": [
    {
      "signal": { "path": "propulsion.*.revolutions" },
      "direction": "above",
      "limit": { "kind": "fixed", "value": 5 }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | Human-readable name, 1-200 characters. Written into alert data. |
| `slug` | Lowercase letters and digits separated by single hyphens, at most 64 characters. Fixed when the rule is created. |
| `condition` | Optional condition name, the last segment of the alert path; see [Alert paths](#alert-paths). Letters, digits, `_` and `-`. Required for a combined signal and for an input path ending in a wildcard. |
| `message` | The alert message, 1-500 characters: a template whose placeholders, such as `{limit}` and `{value}`, are filled in when the alert is sent; see [Messages](#messages). |
| `latching` | Optional; see [Latching](#latching). |
| `signal` | What the rule watches; see [Signals](#signals). |
| `detector` | The condition, with its steps; see [Detectors](#detectors) and [Steps and escalation](#steps-and-escalation). |
| `gates` | Optional, at most 8; see [Gates](#gates). |
| `template` | Optional and informational: the template set (`set`, `version`), the template (`id`) and the `pick` (`instance`, `source`) the rule was made from; see [Templates](templates.md). Nothing reads it to evaluate the rule. |

The slug identifies the rule and is unique among rules. The rule has no `id` or `enabled` field: whether it is disabled is kept apart from it (see [Disable](#disable)).

A rule can be written from scratch or made from a template, a rule whose instance or source is left open for the user to pick. A rule made from a template is an ordinary rule; [Templates](templates.md) describes template sets and how they are used.

### Quantities

Every numeric field is tagged in the schema (`x-quantity`) with how it converts between SI and display units:

| Quantity | Fields | Conversion |
|---|---|---|
| `absolute` | a sustained or projection step's `limit`; a gate's fixed limit `value`; the numeric `value` of a match step, state condition or event | the display unit's full formula |
| `interval` | `hysteresis`; a slope step's `limit` (per second) | the linear part only, so 2 °C of hysteresis is 2 K, not 275.15 K |
| `duration` | `duration`, `clearDuration`, `window`, `horizon`, an absence step's `within` | seconds |
| `count` | a count step's `limit` | unitless |
| `accumulated` | an accumulator step's `limit` | seconds for `time`; the signal's unit times seconds for `integral` |

## Signals

A signal is a single path or a combination of paths on `vessels.self`.

```json
{ "path": "navigation.position", "source": "gnss.bow" }
```

- `path` is relative to `vessels.self`; a path starting with `vessels.` is rejected. It is at most 255 characters.
- `source` is optional. Without it the rule reads the preferred source, as the server ranks sources. With it the rule reads only that `$source`, whatever its rank.
- A path may contain one wildcard segment, `*`, which matches exactly one path segment. Each matching path is an instance of the rule with its own detector and its own alert. The instance name is the segment the wildcard matched. At most 64 instances per rule are admitted; later ones are ignored and reported in the rule's issues.
- A wildcard elsewhere in the rule, in a gate's signal or a zone limit's `path`, binds to the rule signal's instance, so it is allowed only when the rule signal has a wildcard. `propulsion.*.revolutions` in a gate of a rule on `propulsion.*.coolantTemperature` is the port engine's revolutions for the port instance.

A reading is a number, a string, a boolean or a position (`latitude`, `longitude`). A `null` value, a non-finite number or any other value is *unavailable*; `null` with `state.timedOut` is the server's timed-out marker, which is also unavailable except to timeout rules. A signal that has produced nothing since the rule started is *never seen*.

Each input subscribes through the server's subscription manager, which replays the current value of every subscribed path and source at subscribe time. Those replayed values count as readings but never as events, so a switch stuck on reads as on after a restart but does not count as switching on.

### Combinators

```json
{
  "combinator": "absDifference",
  "angular": true,
  "inputs": [
    { "path": "navigation.headingMagnetic", "source": "compass.a" },
    { "path": "navigation.headingMagnetic", "source": "compass.b" }
  ]
}
```

| `combinator` | Inputs | Value |
|---|---|---|
| `difference` | exactly 2 | first minus second |
| `absDifference` | exactly 2 | absolute difference |
| `ratio` | exactly 2 | first divided by second; unavailable when the second is 0 |
| `distance` | exactly 2 positions | great-circle distance in metres, on a sphere of the mean Earth radius |
| `spread` | 2-16 | largest minus smallest |
| `mean` | 2-16 | arithmetic mean |
| `median` | 2-16 | median |
| `positionSpread` | 2-16 positions | largest distance between any two positions, in metres |

- Combinators do not nest, and their inputs have no wildcard.
- `distance` and `positionSpread` take only paths whose last segment is `position`, and positions combine only through them.
- `angular: true` is accepted on `difference`, `absDifference`, `spread` and `mean`, and makes them treat values as angles in radians: a difference wraps to [-π, π), so 358° and 3° are 5° apart; `mean` is the circular mean, unavailable when the inputs cancel out; `spread` is the smallest arc holding every angle. When the rule is validated with the server's path information and the server knows an input's units, anything but `rad` is rejected. A rule saved before its inputs report is checked again whenever it evaluates: once an input's `meta.units` is anything but `rad`, the rule is a problem with the reason `unitsNotRadians`, naming the `path` and its `units`, and an active alert is cleared.
- The combined value exists once every input has reported, and is recomputed whenever any input reports. It is unavailable while any input is unavailable, and timed out when any unavailable input is timed out.

## Detectors

A detector turns a signal into a condition that is active or not. Its `steps` hold its limits, each with the priority the alert has once the condition reaches it; the field lists below describe one step's limit, and [Steps and escalation](#steps-and-escalation) how several combine. Durations run on a monotonic clock, so wall-clock changes do not affect them.

**Input availability.** An unavailable or never-seen input holds the condition as it is and pauses duration timers: a failing sensor neither raises nor clears. Three exceptions:

- Timeout rules match the timed-out marker, and a path not yet seen counts toward their duration from the time the rule comes into use.
- An absence detector's window runs from the time the rule comes into use while its input has never been seen, because silence is what it detects.
- An accumulator with `while` stops accumulating 60 s (core's source timeout) after its last sample, so a device that goes silent without a timed-out marker does not keep adding time.

**Events.** Count, absence, the `changesTo` and `decreases` match operators, and an accumulator's `resetOn` look for events, given as `{ "op": ..., "value": ... }`:

| `op` | Event | `value` |
|---|---|---|
| `changes` | the value differs from the previous one | none |
| `changesTo` | the value changes to `value` | required |
| `decreases` | a number lower than the previous one | none |

A replayed value only sets the baseline. An unavailable reading leaves the baseline alone. For count and absence a value seen live for the first time after start counts as a change from nothing (never as a decrease), so the first pump start or acknowledgment after a restart is not lost; for match and `resetOn` it only sets the baseline.

### match

`op`, `steps` (each with a `value` for `equals`, `notEquals` and `changesTo`, without one otherwise), `duration`.

- `equals`, `notEquals` (step `value` required): active once the value has matched for `duration` (default 0). A non-matching value resets the timer; an unavailable input pauses it.
- `changesTo` (step `value` required), `decreases`: a momentary condition at the event, with no duration. A device reporting for the first time after start raises nothing, since there is no previous value.
- `timedOut` (no step `value`, `duration` required and above 0): a *timeout rule*. Active once the input has carried core's timed-out marker for `duration`, or has not been seen at all for `duration` since the rule came into use (core marks only paths it has seen). Any value ends it. A timeout rule watches a single path, not a combined signal, and is rejected on a path the server reports as boolean or string, when the rule is validated with the server's path information. A rule saved before its path reports is checked when a value arrives: once the path has reported a boolean or a string, the rule is a problem with the reason `timeoutNotPossible` and the cause `booleanPath` (or `stringPath`). It is also a problem with that reason when the server does not enforce data timeouts, when the path declares an update contract other than `periodic`, when its `meta.timeout` is 0 or less, or when it has no `meta.timeout` and the server's default timeouts are off; [State](#conditions-and-reasons) lists the causes.

### sustained

`direction` (`above` or `below`), `steps` (each a `limit`) or a zone `limit`, `duration`, `hysteresis`, `clearDuration`.

Active once the value has been beyond the limit (strictly above or below it) for `duration`. Ends once it has been back past the limit by `hysteresis`, at or below `limit - hysteresis` for `above`, for `clearDuration`. All three default to 0. The timer restarts whenever the value leaves the side it is timing and pauses while the input is unavailable. The limits are the steps' or come from zones (see [Zone limits](#zone-limits)).

### slope

`direction` (`rising` or `falling`), `window`, `steps` (each a `limit`, per second, above 0).

Active while the trend over the last `window` seconds changes faster than `limit` in `direction`. The trend is the least-squares slope of the signal held between samples, weighted by time, so sparse samples cannot produce a steep slope from one step. Unavailable time is left out of the window rather than restarting it. Nothing is decided until a full window of available time is known, and the state holds while the input is unavailable. Input is decimated to a spacing of `window`/256; a window keeps at most 1024 points, including the markers of unavailable stretches.

### projection

`direction` (`rising` or `falling`), `steps` (each a `limit`) or a zone `limit`, `window`, `horizon`.

Active when the value, extended along the trend of the last `window` seconds (as for slope), reaches `limit` within `horizon` seconds, and the trend points toward it, so a flat value never sets it. Once active it holds until the projected value is back on the safe side, so noise around a value already past the limit does not toggle it. With a zone limit, `rising` resolves like `above` and `falling` like `below`; a projection with a zone limit alerts at its named level's priority and does not escalate, because one trend over one horizon reaches every more severe level at the same moment. Typed steps do escalate: each step's limit is one the user chose to be told about.

### accumulator

`measure` (`time` or `integral`), `while`, `resetOn`, `steps` (each a total `limit`, above 0).

Accumulates while the input is available and `while` holds: seconds for `time`, the value integrated over seconds for `integral`. A value holds until the next sample. `while` is `{ "op": "above" | "below" | "equals" | "notEquals", "value": ... }`; `above` and `below` need a number. The condition becomes active when the total reaches `limit` and stays active until a `resetOn` event sets the total to zero. Without `resetOn` it never ends. Only time while the server runs counts. Totals survive a plugin or server restart: Alert Rules saves them every 60 s and when the plugin stops, so a crash loses at most the last minute. Without `while`, an input that stops reporting without a timed-out marker keeps accumulating.

### count

`event`, `window`, `steps` (each a `limit`, a whole number, at least 1).

Active while more than `limit` events fall within the last `window` seconds: with `limit` 4, the fifth event within the window raises. It ends when events age out of the window. The state holds while the input is unavailable.

### absence

`event`, `steps` (each a window `within`, in seconds).

Active once no event has arrived for `within` seconds; ends at the next event. The window starts when the rule comes into use and pauses while the input is unavailable.

## Gates

A gate puts a rule in use only while a condition on another signal holds, such as a coolant rule only while the engine runs. It is a sustained comparison: `signal`, `direction`, `limit`, `duration`, `hysteresis`, `clearDuration`, with the same meaning as for [sustained](#sustained). A rule has at most 8 gates and is in use while every gate holds.

- A gate that stops holding takes the rule out of use and clears its alert. The rule's detector is dropped; when the rule comes back into use it starts afresh, given the last reading, so durations count from then. An accumulator is the exception: it keeps accumulating while its rule is out of use, and only its alert is held back.
- A gate whose input becomes unavailable keeps its last state: an engine that stopped before its controller went silent stays not running, and a tachometer that fails while the engine runs leaves the rule in use.
- A gate whose input has not been seen since start does not hold, except for an alert adopted at restart (see [Restart](#restart-reconciliation)), which is kept until the gate input reports. For such an alert the gate starts as holding and does not wait out its `duration`.
- A gate with a wildcard signal is evaluated per instance; a gate without one is shared by every instance.
- A gate's limit can be a zone limit, resolved like any other; a zone level missing from the path makes the rule a problem with the reason `missingZone` and the gate's index. A gate's zone level does not affect the rule's priority.

## Limits

Every gate has a `limit`, and a sustained or projection detector has either steps or a zone `limit`, never both:

- `{ "kind": "fixed", "value": 3 }`: an SI value; gates only, since a detector's fixed limits are its steps.
- `{ "kind": "zone", "level": "warn", "path": "..." }`: taken from `meta.zones`. `path` is optional and defaults to the signal's path; a combined signal has no single path, so it must name one. `path` may hold the rule's wildcard.

Alert Rules only reads `meta.zones`; it never writes meta.

### Zone limits

A zone limit takes a rule's threshold from the `meta.zones` of a path instead of a fixed value. It names the least severe zone level the rule watches: `alert`, `warn`, `alarm` or `emergency`. The rule covers that level and every more severe level the zones define. Zones in `normal`, `nominal` or any other state raise nothing, give no threshold and play no part in resolving one.

#### Runs

A zone limit works on runs. Take the zones in the named level or a more severe one, and ignore all others. A missing or `null` bound is open, so a zone with no lower bound reaches down without end and one with no upper bound reaches up without end. Sort the zones by lower bound and merge each zone that touches or overlaps the run before it (its lower bound is at or below that run's upper bound) into that run. What remains are the runs: stretches of the range where the value is at the named level or worse, separated by gaps.

#### Threshold

A path can have zones on both sides of its range, such as a battery voltage with a low alarm and a high alarm. The rule's side is the low side for a `below` rule (and a falling projection) and the high side for an `above` rule (and a rising projection). The outermost run on that side is the one the rule watches, and no normal zone is needed to tell the sides apart:

- For `below`, the lowest run. The threshold is its upper edge.
- For `above`, the highest run. The threshold is its lower edge.

That edge must be a bound, not open, and only zones of the named level may supply it: a zone supplies the edge when its upper bound is the edge for `below`, its lower bound for `above`. A run graded from the named level outward has the named level alone at its inner edge and the more severe levels beyond it. On a path zoned on one side only, the outermost run on the unzoned side is the other side's run, with a more severe level at the edge the rule would take, whether that level's zone is adjacent to the named level's or nested inside it and sharing its outer bound (`{ lower: 0.8, upper: 1, state: 'warn' }` with `{ lower: 0.9, upper: 1, state: 'alarm' }`). Taking that edge would put the whole range past the threshold and the rule would alert permanently, so the rule is a problem instead.

For example, with zones `{ upper: 11.5, state: 'alarm' }`, `{ lower: 11.5, upper: 12, state: 'warn' }`, `{ lower: 12, upper: 14.4, state: 'normal' }` and `{ lower: 14.8, state: 'alarm' }`, a `below` rule naming `warn` has threshold 12 and an `above` rule naming `alarm` has threshold 14.8. A path zoned on one side only resolves the same way whether or not its zones are open-ended: engine revolutions zoned `{ lower: 3200, upper: 3600, state: 'warn' }` and `{ lower: 3600, upper: 4000, state: 'alarm' }` give an `above` rule naming `warn` the threshold 3200, while a `below` rule naming `warn` on the same zones does not resolve, because the upper edge of the only run, 4000, comes from the alarm zone.

#### Escalation

A sustained rule resolves each more severe level the zones define the same way, and takes each as a step: it escalates its alert as the value passes that level's threshold. A more severe level is an escalation step only when its threshold is at or beyond the named level's threshold in the rule's direction: at or below it for `below`, at or above it for `above`. A more severe level whose only zones lie on the far side of the range resolves to a threshold short of the named level's, so it is left out. With `{ upper: 12, state: 'warn' }` and `{ lower: 14.8, upper: 20, state: 'alarm' }`, a `below` rule naming `warn` has threshold 12 and no escalation step, because alarm resolves to 20 on its own.

A more severe level that does not resolve is left out of escalation too.

#### When a zone limit does not resolve

The rule is a `problem` with the reason `missingZone` (see [State](#conditions-and-reasons)) when:

- the path has no zone of the named level at all: the facts name the `level`. A more severe zone does not stand in for a missing named level.
- the edge of the outermost run on the rule's side is open, or no zone of the named level supplies it: the facts name the `level` and the `side`, `low` or `high`. This covers a named level defined only on the other side, a rule pointing at the unzoned side of a path zoned on one side only, and a zone at or above the named level with neither bound, which merges everything into one run open at both ends.

#### Known limitations

- Zones on the same side separated by a gap make the rule a problem. With `{ lower: 3200, upper: 3600, state: 'warn' }` and `{ lower: 3800, upper: 4000, state: 'alarm' }`, the highest run is the alarm zone alone, so an `above` rule naming `warn` reports the `warn` level missing on the `high` side. Make the zones touch for the rule to resolve.
- A side lacking the named level makes the rule a problem, even when the other side's zones of that level are bounded on both sides and could be read as lying on the rule's side. With `{ upper: 11.5, state: 'alarm' }` and `{ lower: 14.8, upper: 20, state: 'warn' }`, a `below` rule naming `warn` reports the `warn` level missing on the `low` side.
- A path with a single bounded zone, or with bounded zones all of one level, resolves in either direction, since zones of the named level supply the edges on both sides. With `{ lower: 0, upper: 5, state: 'alarm' }`, a `below` rule naming `alarm` has threshold 5 and an `above` rule naming `alarm` has threshold 0. A rule pointing the wrong way on such a path alerts permanently.

## Steps and escalation

A rule raises one alert at one alert path, and that alert climbs in priority while the condition lasts. The detector's `steps` list the climb, each a limit and a `priority` (`emergency`, `alarm`, `warning` or `caution`); a rule with one step raises at its priority and keeps it. Warning below 12.2 V and alarm below 11.8 V is one rule:

```json
{
  "type": "sustained",
  "direction": "below",
  "steps": [
    { "limit": 12.2, "priority": "warning" },
    { "limit": 11.8, "priority": "alarm" }
  ],
  "duration": 60
}
```

A step's limit depends on the detector: a `limit` for sustained, projection, slope, accumulator and count; a `value` for a match; a window `within` for absence. A rule has one to four steps, one per priority. Validation refuses anything else, with the error on the offending step:

- Priorities strictly increase.
- Limits strictly move in the condition's direction: down for `below` and a falling projection, up for `above`, a rising projection, a slope, a total and a count.
- An `equals` or `changesTo` match takes a different value at each step, such as `fault` at warning and `critical` at alarm. A `notEquals`, `decreases` or `timedOut` match takes one step: an alert left unacknowledged too long is core's to escalate.
- An absence rule's windows grow, such as no heartbeat for 10 min at warning and for 30 min at alarm.

A step's condition holds at that step or beyond it: a value below 11.7 V is beyond both steps, and a match step holds for its own value and every later step's. Each step must hold for the rule's `duration` before the alert climbs to it, so a momentary dip does not escalate, and a value that passes several steps at once raises at the furthest of them. Reaching a further step sends that step's priority and limit at once, with the message filled in from that step's limit (see [Messages](#messages)); a latching rule sends a latching raise at the new priority. A pulse of a `changesTo` match is raised at the furthest step it reaches.

Nothing lowers the priority. Between steps the alert keeps the highest priority it reached, because core never lowers one, while its message and value keep updating. An edit that removes the reached step or lowers its priority does not lower it either: Alert Rules keeps sending and reporting the priority reached until the alert ends. The alert ends only when the condition is back past the first step: for a sustained rule, by its `hysteresis` for its `clearDuration`.

A zone-limit rule has no steps of its own: its steps come from the path's zones, from its named level upwards (see [Escalation](#escalation)), each at its level's priority:

| Zone level | Priority |
|---|---|
| `alert` | `caution` |
| `warn` | `warning` |
| `alarm` | `alarm` |
| `emergency` | `emergency` |

Everything after the raise, acknowledgment, silencing and escalation included, is core's alert lifecycle. Alert Rules never acknowledges, silences or escalates. It reads core's alert state once, at start, to adopt or clear its own alerts (see [Restart reconciliation](#restart-reconciliation)), and not after that.

## Latching

`latching: true` is accepted only on detectors whose condition is an event: a count, or a match with `changesTo` or `decreases`. Each time the condition becomes active, Alert Rules sends one latching raise; it sends no heartbeat and no clear, and core holds the alert until it is acknowledged. The `engine-stopped` example latches. A latching rule with steps sends a latching raise at each step it reaches (see [Steps and escalation](#steps-and-escalation)). A lasting condition cannot latch: after every restart, gate reopening or structural edit it would be seen again and announced as a new occurrence. A lasting condition at a priority that needs acknowledgment already waits for it after the condition returns to normal.

A non-latching `changesTo` or `decreases` match raises and clears at the same instant; what remains of the alert is core's.

## Alerts

### Alert paths

A rule's alert lives in the data model, at a condition name under the parent the rule's input gives: voltage below a limit on `electrical.batteries.house.voltage` alerts at `alerts.electrical.batteries.house.voltageLow`. The parent always follows the input and cannot be edited:

- For a single input path, it is the path's parent. When the path ends in a wildcard, it is the whole path, so that each instance has an alert of its own.
- For a combined signal, it is the longest run of leading segments the parents of all its inputs share: `propulsion.port.revolutions` and `propulsion.starboard.revolutions` give `propulsion`. When they share none, the alert path is the condition name alone.

Only the condition name is the rule's to choose, in its optional `condition` field. Left out, it is the input's leaf, camel-cased, plus a suffix for the detector: `High` or `Low` for a sustained comparison, `ProjectedHigh` or `ProjectedLow` for a projection, `Rising` or `Falling` for a slope, `Match`, `Mismatch`, `Changed`, `Decreased` or `TimedOut` for a match, `Accumulated`, `Frequent` and `Missing` for an accumulator, count and absence. That default follows every edit of the input and detector; a stored name is kept through them. A combined signal and an input ending in a wildcard have no leaf to name the condition by, so they need a stored name.

A wildcard rule's alert path keeps the `*`, and each instance's alert fills it with the instance's segment: `alerts.propulsion.port.coolantTemperatureHigh`. No two rules may have alert paths that could name the same alert, a wildcard overlapping every segment it could take: a create or edit that would is refused (409 on `/condition`), and a stored rule that would does not run. An edit that changes the alert path clears the rule's alerts at the old path and raises at the new one once the condition holds.

Parent segments and the instance segment are the path's or instance name's with every character other than `A-Z`, `a-z`, `0-9`, `_` and `-` replaced by `_`. Two instance names that map to the same segment cannot both be admitted; the later one is reported in the rule's issues. A path under `alerts.` longer than 255 characters, or with a segment of `__proto__`, `constructor` or `prototype`, is not emitted, and the instance is a problem with the reason `alertPathInvalid`.

### What Alert Rules sends

Alert Rules raises through delta ingress: a delta from the plugin, whose id core takes as the alert's `$source`, with the path `alerts.<alert path>` and the value

```json
{
  "priority": "warning",
  "message": "Coolant temperature is rising fast on port",
  "latching": false,
  "references": ["propulsion.port.coolantTemperature"],
  "data": {
    "rule": "coolant-temperature-rising",
    "name": "Coolant temperature rising",
    "instance": "port",
    "valueAtRaise": 357,
    "raisedAt": "2026-09-30T12:00:00.000Z"
  }
}
```

A clear is the value `null`: it reports that the condition ended, and is the last thing Alert Rules sends about the alert.

`references`, written at each raise, lists the data paths the rule reads for the alert's instance: its input paths first, then its zone limit's path, then each gate's input paths and zone limit's path, with the instance's name in place of the wildcard. Duplicates and paths core would refuse are left out, since core drops every reference when it refuses one, and the list keeps the first 50, the most core accepts. A rule that reads no path core accepts sends no `references`.

The keys of `data`, written at each raise:

| Key | Present | Value |
|---|---|---|
| `rule` | always | the rule's `slug` |
| `name` | always | the rule's `name` |
| `instance` | wildcard rules | the instance name as the path has it, before sanitising |
| `limit` | sustained and projection rules | the SI limit of the step the alert has reached, updated as it climbs and when an edit changes that step's limit while that step still has the alert's priority; for a zone limit, that level's threshold. It names a step the alert reached: an edit that inserts a step ahead of the reached one, or an adopted alert, keeps the limit core holds until the next climb. An edit to the reached step's limit sends the new limit even if the value has not crossed it, since the alert keeps that step's priority |
| `valueAtRaise` | when the input had a value | the signal's value at the raise: a number, string, boolean or position |
| `raisedAt` | always | the wall-clock time of the raise, ISO 8601 |

Data holds only what changes rarely, so repeats of the alert cause no store writes for it. Core replaces an alert's data whole, so a climb resends the data with the reached step's `limit` and the rest unchanged. The step reached and the current priority are in the rule state (see [State](#state)), not in the alert's data; the live value is in the rule state and, through `{value}`, in the message.

### Messages

A rule's `message` is a template. Alert Rules fills in its placeholders when it raises the alert, when the alert climbs to a further step, and afresh for every repeat while the alert lasts:

| Placeholder | Filled in with |
|---|---|
| `{instance}` | the wildcard instance's name; empty for a rule without a wildcard |
| `{limit}` | the limit of the step the alert has reached: a sustained or projection step's value (for a zone limit, the level's threshold), a slope's rate per second, a count's number of events, an accumulator's total (a duration for `time`), an absence step's window, or a match step's value. When no step of the rule set the alert's priority, as for an alert adopted at restart above its first step or after an edit inserting a step ahead of the reached one, the `limit` Alert Rules last sent in the alert's data, or, when the data holds none, the limit of the step at the alert's index |
| `{duration}` | the rule's `duration`, for a sustained or match rule |
| `{value}` | the input's last value, a combined signal's combined value |

"House bank voltage below {limit} for {duration}: {value}" reads "House bank voltage below 11.8 V for 30 s: 11.7 V".

Values are in SI, labelled with the unit the input path's `meta.units` names: for a combined signal, its first input's that has one, metres for `distance` and `positionSpread`, and none for `ratio`. A ratio is shown as a percentage. The server's display-unit preferences are resolved per user when the server answers a client and are not readable by a plugin, and a message reads the same for everyone. Durations are in seconds, minutes or hours: 30 s, 5 min, 2 h.

A placeholder with nothing to fill it in reads as a dash, "–": `{duration}` on a rule without one, `{value}` before the input has reported since start, or `{limit}` of a zone limit whose zones have not been read. Any other text in braces stays as written.

A changed value is sent with the next repeat, so the message is at most one heartbeat behind the value, and a burst of changes adds no emissions: Alert Rules sends a changed message at most once per repeat. A message without placeholders is sent unchanged. The rule state's `message` is the message Alert Rules last sent for the alert, or, for an alert not sent since start, such as one adopted while already stale, the message as it reads now (see [State](#state)).

### Heartbeat and input evidence

Core marks an alert stale when its source has not repeated it for 60 s. Alert Rules repeats every active non-latching alert every 10 s with the same value, its message rendered afresh, `references` and data included; an adopted alert's repeats omit both, so core keeps what it stored. A priority change is sent at once, and a message or priority edit goes out with the next repeat.

Alert Rules repeats an alert only while it has input evidence for it, and otherwise lets core mark it stale rather than clearing it; the rule's state shows the alert as awaiting input. An instance has evidence:

- for a timeout rule, always, since the input's silence is the condition;
- for an alert adopted at restart, other than an absence rule's, while its input has a value;
- otherwise, unless its input is unavailable.

The evidence gate stands until core's staleness behaviour is specified (SignalK/signalk-server issue 1857).

### Restart reconciliation

At start Alert Rules reads core's alerts once and sorts those whose `$source` is Alert Rules and whose condition is active, matching each to the rule whose [alert path](#alert-paths) is the alert's, a wildcard rule's with an instance segment in place of its `*`:

- An alert that matches no rule, because its rule no longer exists or now has another alert path, or that matches a rule now latching, is cleared. An alert of a disabled rule is adopted and cleared at the rule's first evaluation, as disabling would have cleared it.
- Every other such alert is adopted. Alert Rules sends it once as soon as its rules have started, with the rule's current message filled in from the values the inputs replayed at start, the more severe of core's priority and its first step's (for a zone-limit rule, its named level's), and no data, so core keeps the data it stored, unless core already marks it stale; an edit made while Alert Rules was down reaches core this way. The instance's detector starts in the active state at the first step, with core's priority as the most severe it has reached. Core's priority names no step, because it is not evidence of which step's condition held. The rule's state reports step 0 at that priority, and the following repeats carry it.

Alerts whose condition has ended, latching alerts among them, are core's until acknowledged and are left alone, as are other sources' alerts. Alert paths are shared with every other source, and core keeps one alert per path, attributed to the source that raised it last: an alert at a rule's path that another source raised last is that source's, so Alert Rules neither adopts nor clears it. While both run, they share that one alert.

An adopted alert ends by its rule's clear criterion or a gate not holding, like any other. Until then:

- Unavailable and never-seen inputs, gate inputs and wildcard instances hold it, so sensors that report late cannot clear it. A wildcard instance is gone only when its rule cannot have it at all, not when it has not reported yet.
- A count detector does not end it before one full window has passed since start, because events before start are unknown. Slope and projection detectors decide nothing until they have a full window of available time. An absence detector ends it at the first event.
- An adopted alert stays at the first step until a further step's own condition has held for its duration. It then climbs as any alert does, and only then is the `limit` in core's data changed, to that step's.

### Stopping

Stopping the plugin never clears alerts. Stop runs on every configuration save, on enabling or disabling the plugin in the server and on server shutdown, and the plugin cannot tell them apart; clearing would end every active alert on each of them, and the next start would raise it again. On a server without the alerts API the plugin reports an error and evaluates nothing. Alerts left in core while the plugin is stopped go stale without its heartbeat, and the next start adopts them as [restart reconciliation](#restart-reconciliation) describes, so each rule keeps or clears its alert. To stop a rule raising an erroneous alert, [disable](#disable) the rule.

## Edits

An edited rule saved through the [REST API](api.md) replaces the running one without restarting the plugin or other rules. The API can preview an edit, saying whether it would clear an active alert.

| Edit | Effect on an active alert |
|---|---|
| signal (paths, sources, combinator, `angular`), gates, `latching`, detector `type`; a match's `op` or step values; `direction`; a zone limit's `level`, or a change between steps and a zone limit; an accumulator's `measure`, `while` or `resetOn`; a count's or absence's `event` | cleared, and the rule restarts from nothing; it raises again once its condition holds |
| step limits and windows, a step added or removed (other than a match's), a zone limit's `path`, `duration`, `clearDuration`, `hysteresis`, `window`, `horizon` | re-evaluated in place; timers and windows are kept, and the current value is checked against the new limits before any timer counts. An added step starts its own detector at the edit and must hold for the duration before the alert climbs to it: a count step counts only events after the edit, an absence step's window starts at the edit, a slope or projection step decides nothing until it has a full window, and an accumulator step starts from the total reached; an alert whose step was removed stays at the furthest step left, at the priority it reached |
| `message`, step priorities | sent with the next emission. A lowered priority does not lower an active alert's |
| delete, disable, accumulator reset | cleared |

A restarted accumulator keeps its total when its `measure` is unchanged. An edit or delete that discards a total saves the totals at once, so a restart cannot give the old total to the new rule. Each saved total records the measure it was built under, and a total whose measure differs from its rule's is dropped at start, so a rule never takes over a total of another measure, even when that save failed on a full disk.

A match's step values and a zone limit's `level` change what the alert means, so they restart the rule. Re-evaluated in place, a match of a value no longer listed would hold until the next sample. For a zone limit, re-evaluated in place, an active alert would report the new level at once, while its detector waits out `clearDuration`, although the value may never have entered that level. After the restart the rule raises at the new level only once the value has been in it for `duration`.

## Disable

A rule is enabled or disabled. Disabling stops a rule raising alerts without deleting it: for a sensor known to be faulty, or equipment out of service. It acts on the rule, not on an alert already raised; acknowledging or silencing an alert is core's alert lifecycle, done in the alert console. A rule is disabled or enabled through the [REST API](api.md#rule-controls), by a read/write user or an administrator, with an optional note of at most 500 characters saying why. The webapp offers Disable in the rule's detail view, with the note in its confirmation.

The rule keeps a record of who disabled it, when, and the note, in the data directory across restarts, and its entry carries the record while it is disabled. Disabling a disabled rule replaces the record; enabling an enabled rule changes nothing. Editing a rule keeps it disabled, and deleting it deletes the record, so a rule created again with its slug starts enabled. Disables and enables are recorded in the [action log](api.md#action-log) with the acting user and the note.

A disabled rule keeps evaluating, so its [state](#state) shows whether its condition holds, but it raises nothing. Disabling it clears its active alerts at once, as a delete does. Nothing enables a rule but the user. Enabling it raises at once, as a new alert, when its state shows the condition `present`, as it has held for its duration. A rule enabled while its detector is still timing raises when the duration has run, and one whose condition held when its gate last closed raises once the restarted detector sets (see [State](#state)). An accumulator keeps counting while its rule is disabled, and the rule can still be edited, reset and deleted.

## Resource bounds

| Bound | Value |
|---|---|
| rules loaded | 500 |
| templates per template set | 500 |
| instances per wildcard signal | 64 |
| gates per rule | 8 |
| combinator inputs | 16 |
| durations, windows, horizons | at most 24 h; windows and horizons above 0 |
| points kept per slope or projection window | decimated to a spacing of `window`/256; at most 1024, including gap markers |
| slug | 64 characters |
| `name`, `message` | 200 and 500 characters |
| signal path, alert path | 255 characters |
| template set file | 1 MiB; YAML alias expansion capped at 100 |

## State

For each rule Alert Rules reports its state on two separate axes: the rule is `enabled` or `disabled`, and its condition is one of the conditions below. Each condition comes with a reason code and the facts an explanation is worded from; Alert Rules sends no prose, so the reader words the explanation. An error in one rule is recorded in its state and does not stop the others. Values are in SI units and times are ISO 8601; converting values to display units is the reader's job.

Per rule:

- `ruleState`: `enabled` or `disabled`; `disabled` on the entry records who disabled the rule, when and why.
- `condition`, `reason` and the reason's facts: an evaluation error makes the rule a `problem` with the reason `evaluationError`, whatever its instances report, as none of them is current then. Otherwise they are those of its worst instance, in the order `alerting` (or `present`), `problem`, `noData`, `normal`, the first of equal ones, with that instance's row fields (`instance` names it for a wildcard rule). A wildcard rule with no instance yet is `noData` with the reason `neverReported`.
- `changedAt`: when the rule state or the condition last changed, as judged at each evaluation; an evaluation that changes neither does not move it, nor does a change of reason within one condition. It is kept in memory, so at every plugin start, which every configuration save causes, it starts over at the first evaluation; only an enabled rule alerting through an alert adopted at the start keeps the `raisedAt` of its earliest such alert.
- `errors`: diagnostic text for what makes the rule a problem, such as an evaluation that threw, a start that threw, or a subscription the server refused. An evaluation or start error stays until the rule is edited, a subscription error until an edit restarts the rule. A rule that fails to start does not evaluate; the other rules start as usual.
- `issues`: diagnostic text for conditions that do not stop the rule, such as a wildcard instance that was not admitted.
- `instances`: one row per instance, a single one for a rule without a wildcard.

Per instance, its `condition`, `reason` and the reason's facts, and:

| Field | Meaning |
|---|---|
| `instance` | `name` and `segment`, for a wildcard rule |
| `value` | the signal's current value, while it has one; a combined signal's combined value |
| `limit` | a sustained or projection rule's limit in force: the reached step's while the alert is active, else the first step's; for a zone limit, the matching level's threshold |
| `progress` | `{ "kind": "events", "count", "limit" }`, a count's events in its window, which sets when `count` exceeds the first step's `limit`; or `{ "kind": "total", "total", "limit" }`, an accumulator's total and its first step's limit. Absent for other detectors: timers toward a transition are not reported |
| `gates` | per gate, in the rule's order: `path` (the path it reads for this instance; absent for a combined signal), `value` while it has one, `holds`, and `input` (`value`, `unavailable` or `neverSeen`). An unavailable gate input keeps the gate's last state |

### Conditions and reasons

An instance's condition is the first of these that applies:

| Condition | Reason | When | Facts |
|---|---|---|---|
| `problem` | `missingZone` | a zone level the limit names is missing from the path, or from a gate's path | `level`, `side` (`low` or `high`) when the level exists only on the other side, `gate` (index) for a gate's |
| `problem` | `timeoutNotPossible` | a timeout rule whose path the server can never time out | `cause`: `booleanPath`, `stringPath`, `notEnforced` (the server does not enforce timeouts), `updateContract` (with `contract`, the path's update contract other than `periodic`), `timeoutOff` (`meta.timeout` of 0 or less), `noTimeout` (no `meta.timeout` and the server's default timeouts off) |
| `problem` | `unitsNotRadians` | an angular combination of an input the server reports in other units | `path`, `units` |
| `problem` | `alertPathInvalid` | the instance's alert path is one core would not accept | |
| `alerting` | `alertActive` | the alert is active; never for a disabled rule | `priority` and `step` reached (an index from 0; an edit does not lower the priority), `level` for a zone limit, `awaitingInput` when the input has no evidence and the alert is not repeated (see [Heartbeat and input evidence](#heartbeat-and-input-evidence)), `message`, the alert's message with its placeholders filled in as Alert Rules last sent it, or as it reads now for an alert not sent since start (see [Messages](#messages)) |
| `normal` | `outsideGate` | a gate does not hold | the gate facts in `gates` |
| `present` | `conditionPresent` | a disabled rule's condition holds | |
| `noData` | `inputUnavailable` | the input is unavailable | `lastSeen`, when it last had a value since start |
| `noData` | `neverReported` | the input has not reported since start | |
| `normal` | `withinLimits` | none of the above, a rule waiting out its duration included | `clearedAt`, when the condition last stopped holding; for a disabled rule whose condition has not held since the rule started evaluating, `clearSince`, that start time |

A rule waiting out its duration is `normal`: the timer is not exposed.

A disabled rule's condition is `present` when it holds, judged in this run: an alert adopted at restart makes the condition present only once the input reports, so until then the rule has `noData`, unless its condition is the input's silence (an absence or timeout rule). A gate closing and reopening is not the condition clearing: outside its gate a rule is `normal` with the reason `outsideGate`, and a condition that held when the gate closed is undecided once the gate reopens, until the restarted detector has decided: it sets, or shows the condition gone with a reading past a sustained rule's recovery margin, a full window of a slope, a projected value back on the safe side of the limit for a projection, a full window since the reopening for a count, a non-matching reading for a match or an event for an absence rule. An unavailable input decides nothing. While undecided the condition is neither present nor cleared, whether the rule is enabled or disabled: the rule is `normal` with the reason `withinLimits` and no clear time, and it raises nothing until the detector sets. When the condition last stopped holding is kept in memory only, so after a restart a disabled rule whose condition is clear reports `clearSince`, the start time, instead of `clearedAt`.

A rule that is not evaluated, because the plugin has not started evaluating, has the condition `noData` with the reason `notEvaluated`, no errors or issues, and one instance row per accumulator total it keeps, with `progress` and, for a wildcard rule, `instance` with the `segment` only.

A stored rule that does not run, because it does not validate, names another slug than its file, or overlaps the alert path of a rule loaded before it, is a `problem` with the reason `invalidRule` and no instances; its validation errors and stored body come with it, as [the API](api.md#invalid-rule-entry) describes.

## Worked examples

Each rule in [`examples/rules`](../examples/rules) runs in `test/examples.test.ts` against the scenario of the same name in `test/fixtures/example-scenarios.ts`, from a plugin start at 0 s. The table summarises the sequence the test asserts, with heartbeats left out.

| Example | Rule | Scenario | Alerts |
|---|---|---|---|
| `house-battery-low` | Sustained below the house battery's `warn` zone for 60 s, clearing 0.2 V above it after 30 s; escalates through `alarm`. | Zones: `warn` 11.5-12 V, `alarm` below 11.5 V. 12.6 V, 11.8 V at 10 s, 11.3 V at 100 s, 12.1 V at 200 s, 12.4 V at 300 s. | 70 s raise warning; 160 s priority alarm; 330 s clear. 12.1 V at 200 s leaves `alarm` but is inside the 0.2 V hysteresis of `warn`; the alert stays at alarm, since nothing lowers a priority. |
| `bilge-pump-cycling` | Count: more than 4 bilge pump starts within an hour, warning. | Pump on for 60 s every 10 min from 0 s, five times. | 2400 s raise warning (fifth start); 3600 s clear (first start ages out). |
| `engine-service-due` | Accumulator: 250 h of engine running (revolutions above 0), caution. | Revolutions every minute: running for 200 h, stopped for 10 h, running again. | 260 h raise caution. No `resetOn`, so it never clears. |
| `coolant-temperature-rising` | Slope: each engine's coolant rising faster than 0.02 K/s over 5 min, gated on that engine's revolutions above 5 Hz, warning. | Both engines run; port coolant climbs 0.05 K/s from 300 s; port engine stops at 600 s. | 440 s raise warning on `.port`; 600 s clear on `.port` (gate). Starboard raises nothing. |
| `fresh-water-running-out` | Projection: the fresh water tank, on its 30 min trend, reaching 5 % within 2 h, caution. | Level 0.60 steady, draining 0.36 per hour from 1800 s to 4200 s, then steady at 0.36. | 2880 s raise caution; 5220 s clear (trend flattened). |
| `engine-rpm-mismatch` | Sustained absolute difference of port and starboard revolutions above 3 Hz for 30 s, gated on both engines above 8 Hz for 10 s, caution. | Both at 20 Hz; starboard 15 Hz at 60 s, 19 Hz at 150 s. | 90 s raise caution; 150 s clear. |
| `gnss-disagree` | Sustained spread of three named GNSS sources' positions above 50 m for 20 s, warning. | Receivers about 20 m apart; the mast receiver moves about 110 m at 30 s and back at 100 s. | 50 s raise warning; 100 s clear. |
| `watch-not-acknowledged` | Absence: no change of the watch acknowledgment for 15 min, alarm. | Acknowledged at 300 s, 600 s and 1600 s. | 1500 s raise alarm; 1600 s clear. |
| `compasses-disagree` | Sustained angular difference of two named compass sources above 0.1 rad for 60 s, caution. | 358° and 3° (5° apart across north); compass B at 5° from 30 s, at 1° from 150 s. | 90 s raise caution; 150 s clear. |
| `engine-stopped` | Match: each engine's state changes to `stopped`, warning, latching. | Port reports `started`; starboard first reports `stopped`; port `stopped` at 600 s. | 600 s latching raise warning on `.port`; no clear. Starboard's first report raises nothing. |
| `depth-sensor-silent` | Timeout: depth timed out for 30 s, warning. | Depth every 10 s; core marks it timed out at 30 s; depth again from 90 s. | 60 s raise warning; 90 s clear. |

## Decided, not yet implemented

The plan (issue 1) has decided the following; later units implement them.

- **Zone and timeout proposals** ([Unit 10](https://github.com/hatlabs/signalk-alert-rules/issues/11), after the MVP).
