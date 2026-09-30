# Rules

This is the reference for SKAR's rule model: what a rule consists of, how it is evaluated, and what it sends to the Signal K alerts API. Field names are those of the rule schema in `src/model/rule.ts`. Every number in a rule is in SI units.

The rules in [`examples/rules`](../examples/rules) are complete, valid rules; [Worked examples](#worked-examples) shows what each one raises and clears.

## Rule

```json
{
  "name": "Coolant temperature rising",
  "slug": "coolant-temperature-rising",
  "message": "Coolant temperature is rising fast on {instance}",
  "priority": "warning",
  "signal": { "path": "propulsion.*.coolantTemperature" },
  "detector": { "type": "slope", "direction": "rising", "window": 300, "limit": 0.02 },
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
| `slug` | Lowercase letters and digits separated by single hyphens, at most 64 characters. Fixed when the rule is created; it names the alert path. |
| `message` | The alert message, 1-500 characters. `{instance}` is replaced with the wildcard instance's name. The message is the same at every zone level. |
| `priority` | `emergency`, `alarm`, `warning` or `caution`. Required unless the detector has a zone limit, and rejected when it has one, because the zone level sets the priority. |
| `latching` | Optional; see [Latching](#latching). |
| `signal` | What the rule watches; see [Signals](#signals). |
| `detector` | The condition; see [Detectors](#detectors). |
| `gates` | Optional, at most 8; see [Gates](#gates). |

A rule has an origin: `user` for rules written by the user, or the slug of the ruleset that provides it. Origin and slug together identify the rule and must be unique. The rule has no `id` or `enabled` field.

A ruleset (`src/model/ruleset.ts`) is a document with `name`, `slug`, `version`, optional `description`, up to 32 `parameters` (`name`, `type` `number` or `string`, optional `description`, `unit`, `minimum`, `maximum`, and a `default`) and up to 500 `rules`. A ruleset rule may put `{ "param": "<name>" }` wherever a number goes and `${name}` inside a path. A ruleset slug may not be `user`, and two rulesets with the same slug are both rejected. Validation checks every rule with the parameters at their defaults.

### Quantities

Every numeric field is tagged in the schema (`x-quantity`) with how it converts between SI and display units:

| Quantity | Fields | Conversion |
|---|---|---|
| `absolute` | a fixed limit's `value`; the numeric `value` of a match, state condition or event | the display unit's full formula |
| `interval` | `hysteresis`; a slope's `limit` (per second) | the linear part only, so 2 °C of hysteresis is 2 K, not 275.15 K |
| `duration` | `duration`, `clearDuration`, `window`, `horizon`, `within` | seconds |
| `count` | a count's `limit` | unitless |
| `accumulated` | an accumulator's `limit` | seconds for `time`; the signal's unit times seconds for `integral` |

## Signals

A signal is a single path or a combination of paths on `vessels.self`.

```json
{ "path": "navigation.position", "source": "gnss.bow" }
```

- `path` is relative to `vessels.self`; a path starting with `vessels.` is rejected. It is at most 255 characters.
- `source` is optional. Without it the rule reads the preferred source, as the server ranks sources. With it the rule reads only that `$source`, whatever its rank.
- A path may contain one wildcard segment, `*`, which matches exactly one path segment. Each matching path is an instance of the rule with its own detector and its own alert. The instance name is the segment the wildcard matched. At most 64 instances per rule are admitted; later ones are ignored and reported in the rule's status.
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
- `angular: true` is accepted on `difference`, `absDifference`, `spread` and `mean`, and makes them treat values as angles in radians: a difference wraps to [-π, π), so 358° and 3° are 5° apart; `mean` is the circular mean, unavailable when the inputs cancel out; `spread` is the smallest arc holding every angle. When the rule is validated with the server's path information and the server knows an input's units, anything but `rad` is rejected. The check is not repeated when the path reports.
- The combined value exists once every input has reported, and is recomputed whenever any input reports. It is unavailable while any input is unavailable, and timed out when any unavailable input is timed out.

## Detectors

A detector turns a signal into a condition that is active or not. Durations run on a monotonic clock, so wall-clock changes do not affect them.

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

`op`, `value`, `duration`.

- `equals`, `notEquals` (`value` required): active once the value has matched for `duration` (default 0). A non-matching value resets the timer; an unavailable input pauses it.
- `changesTo` (`value` required), `decreases`: a momentary condition at the event, with no duration. A device reporting for the first time after start raises nothing, since there is no previous value.
- `timedOut` (no `value`, `duration` required and above 0): a *timeout rule*. Active once the input has carried core's timed-out marker for `duration`, or has not been seen at all for `duration` since the rule came into use (core marks only paths it has seen). Any value ends it. A timeout rule watches a single path, not a combined signal, and is rejected on a path the server reports as boolean or string, when the rule is validated with the server's path information; the check is not repeated when the path reports. It is inactive, with the reason in its status, when the server does not enforce data timeouts, when the path declares an update contract other than `periodic`, when its `meta.timeout` is 0 or less, or when it has no `meta.timeout` and the server's default timeouts are off.

### sustained

`direction` (`above` or `below`), `limit`, `duration`, `hysteresis`, `clearDuration`.

Active once the value has been beyond the limit (strictly above or below it) for `duration`. Ends once it has been back past the limit by `hysteresis`, at or below `limit - hysteresis` for `above`, for `clearDuration`. All three default to 0. The timer restarts whenever the value leaves the side it is timing and pauses while the input is unavailable. The limit is fixed or from zones; a zone limit escalates (see [Zone limits](#zone-limits)).

### slope

`direction` (`rising` or `falling`), `window`, `limit` (per second, above 0).

Active while the trend over the last `window` seconds changes faster than `limit` in `direction`. The trend is the least-squares slope of the signal held between samples, weighted by time, so sparse samples cannot produce a steep slope from one step. Unavailable time is left out of the window rather than restarting it. Nothing is decided until a full window of available time is known, and the state holds while the input is unavailable. Input is decimated to a spacing of `window`/256; a window keeps at most 1024 points, including the markers of unavailable stretches.

### projection

`direction` (`rising` or `falling`), `limit`, `window`, `horizon`.

Active when the value, extended along the trend of the last `window` seconds (as for slope), reaches `limit` within `horizon` seconds, and the trend points toward it, so a flat value never sets it. Once active it holds until the projected value is back on the safe side, so noise around a value already past the limit does not toggle it. With a zone limit, `rising` resolves like `above` and `falling` like `below`; a projection alerts at its named level's priority and does not escalate, because one trend over one horizon reaches every more severe level at the same moment.

### accumulator

`measure` (`time` or `integral`), `while`, `resetOn`, `limit`.

Accumulates while the input is available and `while` holds: seconds for `time`, the value integrated over seconds for `integral`. A value holds until the next sample. `while` is `{ "op": "above" | "below" | "equals" | "notEquals", "value": ... }`; `above` and `below` need a number. The condition becomes active when the total reaches `limit` and stays active until a `resetOn` event sets the total to zero. Without `resetOn` it never ends. Only time while the server runs counts. Without `while`, an input that stops reporting without a timed-out marker keeps accumulating.

### count

`event`, `window`, `limit` (a whole number, at least 1).

Active while more than `limit` events fall within the last `window` seconds: with `limit` 4, the fifth event within the window raises. It ends when events age out of the window. The state holds while the input is unavailable.

### absence

`event`, `within`.

Active once no event has arrived for `within` seconds; ends at the next event. The window starts when the rule comes into use and pauses while the input is unavailable.

## Gates

A gate puts a rule in use only while a condition on another signal holds, such as a coolant rule only while the engine runs. It is a sustained comparison: `signal`, `direction`, `limit`, `duration`, `hysteresis`, `clearDuration`, with the same meaning as for [sustained](#sustained). A rule has at most 8 gates and is in use while every gate holds.

- A gate that stops holding takes the rule out of use and clears its alert. The rule's detector is dropped; when the rule comes back into use it starts afresh, given the last reading, so durations count from then. An accumulator is the exception: it keeps accumulating while its rule is out of use, and only its alert is held back.
- A gate whose input becomes unavailable keeps its last state: an engine that stopped before its controller went silent stays not running, and a tachometer that fails while the engine runs leaves the rule in use.
- A gate whose input has not been seen since start does not hold, except for an alert adopted at restart (see [Restart](#restart-reconciliation)), which is kept until the gate input reports. For such an alert the gate starts as holding and does not wait out its `duration`.
- A gate with a wildcard signal is evaluated per instance; a gate without one is shared by every instance.
- A gate's limit can be a zone limit, resolved like any other; a zone level missing from the path makes the rule inactive with that reason. A gate's zone level does not affect the rule's priority.

## Limits

A sustained or projection detector, and every gate, has a `limit`:

- `{ "kind": "fixed", "value": 3 }`: an SI value.
- `{ "kind": "zone", "level": "warn", "path": "..." }`: taken from `meta.zones`. `path` is optional and defaults to the signal's path; a combined signal has no single path, so it must name one. `path` may hold the rule's wildcard.

SKAR only reads `meta.zones`; it never writes meta.

### Zone limits

A zone limit takes a rule's threshold from the `meta.zones` of a path instead of a fixed value. It names the least severe zone level the rule watches: `alert`, `warn`, `alarm` or `emergency`. The rule covers that level and every more severe level the zones define. Zones in `normal`, `nominal` or any other state raise nothing, give no threshold and play no part in resolving one.

#### Runs

A zone limit works on runs. Take the zones in the named level or a more severe one, and ignore all others. A missing or `null` bound is open, so a zone with no lower bound reaches down without end and one with no upper bound reaches up without end. Sort the zones by lower bound and merge each zone that touches or overlaps the run before it (its lower bound is at or below that run's upper bound) into that run. What remains are the runs: stretches of the range where the value is at the named level or worse, separated by gaps.

#### Threshold

A path can have zones on both sides of its range, such as a battery voltage with a low alarm and a high alarm. The rule's side is the low side for a `below` rule (and a falling projection) and the high side for an `above` rule (and a rising projection). The outermost run on that side is the one the rule watches, and no normal zone is needed to tell the sides apart:

- For `below`, the lowest run. The threshold is its upper edge.
- For `above`, the highest run. The threshold is its lower edge.

That edge must be a bound, not open, and only zones of the named level may supply it: a zone supplies the edge when its upper bound is the edge for `below`, its lower bound for `above`. A run graded from the named level outward has the named level alone at its inner edge and the more severe levels beyond it. On a path zoned on one side only, the outermost run on the unzoned side is the other side's run, with a more severe level at the edge the rule would take, whether that level's zone is adjacent to the named level's or nested inside it and sharing its outer bound (`{ lower: 0.8, upper: 1, state: 'warn' }` with `{ lower: 0.9, upper: 1, state: 'alarm' }`). Taking that edge would put the whole range past the threshold and the rule would alert permanently, so the rule is inactive instead.

For example, with zones `{ upper: 11.5, state: 'alarm' }`, `{ lower: 11.5, upper: 12, state: 'warn' }`, `{ lower: 12, upper: 14.4, state: 'normal' }` and `{ lower: 14.8, state: 'alarm' }`, a `below` rule naming `warn` has threshold 12 and an `above` rule naming `alarm` has threshold 14.8. A path zoned on one side only resolves the same way whether or not its zones are open-ended: engine revolutions zoned `{ lower: 3200, upper: 3600, state: 'warn' }` and `{ lower: 3600, upper: 4000, state: 'alarm' }` give an `above` rule naming `warn` the threshold 3200, while a `below` rule naming `warn` on the same zones does not resolve, because the upper edge of the only run, 4000, comes from the alarm zone.

#### Escalation

A sustained rule resolves each more severe level the zones define the same way, and escalates its alert as the value passes that level's threshold. A more severe level is an escalation step only when its threshold is at or beyond the named level's threshold in the rule's direction: at or below it for `below`, at or above it for `above`. A more severe level whose only zones lie on the far side of the range resolves to a threshold short of the named level's, so it is left out. With `{ upper: 12, state: 'warn' }` and `{ lower: 14.8, upper: 20, state: 'alarm' }`, a `below` rule naming `warn` has threshold 12 and no escalation step, because alarm resolves to 20 on its own.

A more severe level that does not resolve is left out of escalation too.

#### When a zone limit does not resolve

The rule is inactive, with one of these reasons, when:

- the path has no zone of the named level at all: "the path has no `<level>` zone". A more severe zone does not stand in for a missing named level.
- the edge of the outermost run on the rule's side is open, or no zone of the named level supplies it: "the path has no `<level>` zone on the `<low|high>` side". This covers a named level defined only on the other side, a rule pointing at the unzoned side of a path zoned on one side only, and a zone at or above the named level with neither bound, which merges everything into one run open at both ends.

#### Known limitations

- Zones on the same side separated by a gap make the rule inactive. With `{ lower: 3200, upper: 3600, state: 'warn' }` and `{ lower: 3800, upper: 4000, state: 'alarm' }`, the highest run is the alarm zone alone, so an `above` rule naming `warn` reports "the path has no warn zone on the high side". Make the zones touch for the rule to resolve.
- A side lacking the named level makes the rule inactive, even when the other side's zones of that level are bounded on both sides and could be read as lying on the rule's side. With `{ upper: 11.5, state: 'alarm' }` and `{ lower: 14.8, upper: 20, state: 'warn' }`, a `below` rule naming `warn` reports "the path has no warn zone on the low side".
- A path with a single bounded zone, or with bounded zones all of one level, resolves in either direction, since zones of the named level supply the edges on both sides. With `{ lower: 0, upper: 5, state: 'alarm' }`, a `below` rule naming `alarm` has threshold 5 and an `above` rule naming `alarm` has threshold 0. A rule pointing the wrong way on such a path alerts permanently.

## Priorities and escalation

A rule with a fixed limit, or with no limit, raises at its `priority` and keeps it. A rule whose detector has a zone limit has no `priority`; it raises at the priority of the zone level it holds:

| Zone level | Priority |
|---|---|
| `alert` | `caution` |
| `warn` | `warning` |
| `alarm` | `alarm` |
| `emergency` | `emergency` |

A sustained rule with a zone limit runs one detector per zone level: the named level and each more severe level that is an escalation step (see [Escalation](#escalation)), all with the rule's `duration`, `hysteresis` and `clearDuration`. The alert's priority is that of the most severe level whose detector is active. When that rises, SKAR sends the higher priority at once and core escalates the alert. When it falls, SKAR sends the lower priority and core keeps the higher one, because core never lowers a priority. The condition, and so the alert, ends only when the named level's detector ends. The message stays the same at every level, so a fall does not re-alert.

Everything after the raise, acknowledgment, silencing and escalation included, is core's alert lifecycle. SKAR never acknowledges, silences or escalates. It reads core's alert state once, at start, to adopt or clear its own alerts (see [Restart reconciliation](#restart-reconciliation)), and not after that.

## Latching

`latching: true` is accepted only on detectors whose condition is an event: a count, or a match with `changesTo` or `decreases`. Each time the condition becomes active, SKAR sends one latching raise; it sends no heartbeat and no clear, and core holds the alert until it is acknowledged. The `engine-stopped` example latches. A lasting condition cannot latch: after every restart, gate reopening or structural edit it would be seen again and announced as a new occurrence, and a latching zone-limit rule could never escalate. A lasting condition at a priority that needs acknowledgment already waits for it after the condition returns to normal.

A non-latching `changesTo` or `decreases` match raises and clears at the same instant; what remains of the alert is core's.

## Alerts

### Alert paths

A rule's alert lives at `alerts.rules.<origin>.<slug>`, and a wildcard rule's at `alerts.rules.<origin>.<slug>.<instance>`, one alert per instance. The `rules` segment is reserved for SKAR by convention; SKAR does not check whether another source writes under it. There is no user-overridable alert path.

The instance segment is the instance name with every character other than `A-Z`, `a-z`, `0-9`, `_` and `-` replaced by `_`. Two instance names that map to the same segment cannot both be admitted; the later one is reported in the rule's status. A path under `alerts.` longer than 255 characters, or with a segment of `__proto__`, `constructor` or `prototype`, is not emitted and is reported in status.

### What SKAR sends

SKAR raises through delta ingress: a delta from the plugin, whose id core takes as the alert's `$source`, with the path `alerts.<alert path>` and the value

```json
{
  "priority": "warning",
  "message": "Coolant temperature is rising fast on port",
  "latching": false,
  "data": {
    "rule": "user.coolant-temperature-rising",
    "name": "Coolant temperature rising",
    "instance": "port",
    "valueAtRaise": 357,
    "raisedAt": "2026-09-30T12:00:00.000Z"
  }
}
```

A clear is the value `null`: it reports that the condition ended, and is the last thing SKAR sends about the alert.

The keys of `data`, written at each raise:

| Key | Present | Value |
|---|---|---|
| `rule` | always | `<origin>.<slug>` |
| `name` | always | the rule's `name` |
| `instance` | wildcard rules | the instance name as the path has it, before sanitising |
| `limit` | sustained and projection rules | the SI limit in force at the raise; for a zone limit, the named level's threshold |
| `valueAtRaise` | when the input had a value | the signal's value at the raise: a number, string, boolean or position |
| `raisedAt` | always | the wall-clock time of the raise, ISO 8601 |

Data holds only what changes rarely, so repeats of the alert cause no store writes. The zone level held, the current priority and whether the input has a value are in SKAR's rule status (see [Status](#status)), not in the alert. Live values and time beyond the limit are not reported yet (see [Decided, not yet implemented](#decided-not-yet-implemented)).

### Heartbeat and input evidence

Core marks an alert stale when its source has not repeated it for 60 s. SKAR repeats every active non-latching alert every 20 s with the same value, data included; an adopted alert's repeats omit `data`, so core keeps what it stored. A priority change is sent at once, and a message or priority edit goes out with the next repeat. Core treats an unchanged repeat as a refresh; it re-alerts on a changed message and escalates on a higher priority.

SKAR repeats an alert only while it has input evidence for it, and otherwise lets core mark it stale rather than clearing it; the rule's status shows the alert as awaiting input. An instance has evidence:

- for a timeout rule, always, since the input's silence is the condition;
- for an alert adopted at restart, other than an absence rule's, while its input has a value;
- otherwise, unless its input is unavailable.

The 20 s interval and the evidence gate stand until core's staleness behaviour is specified (SignalK/signalk-server issue 1857).

### Restart reconciliation

At start SKAR reads core's alerts once and sorts those whose `$source` is SKAR, whose condition is active and whose path is under `alerts.rules.`:

- An alert whose rule no longer exists, whose rule is now latching, or whose path has an instance segment when the rule has no wildcard (or lacks one when it has) is cleared.
- Every other such alert is adopted. SKAR sends it once at once, with the rule's current message and the rule's own priority (for a zone-limit rule, its named level's) and no data, unless core already marks it stale; an edit made while SKAR was down reaches core this way. The instance's detector starts in the active state.

Alerts whose condition has ended, latching alerts among them, are core's until acknowledged and are left alone, as are other sources' alerts.

An adopted alert ends by its rule's clear criterion or a gate not holding, like any other. Until then:

- Unavailable and never-seen inputs, gate inputs and wildcard instances hold it, so sensors that report late cannot clear it. A wildcard instance is gone only when its rule cannot have it at all, not when it has not reported yet.
- A count detector does not end it before one full window has passed since start, because events before start are unknown. Slope and projection detectors decide nothing until they have a full window of available time. An absence detector ends it at the first event.
- A zone-limit alert holds its named level until a more severe level has been entered for the duration.

### Stopping

Stopping the plugin never clears alerts. Stop runs on every configuration save, enable, disable and server shutdown, and SKAR cannot tell them apart; clearing would re-alert the operator each time. On a server without the alerts API the plugin reports an error and evaluates nothing.

## Edits

The engine applies an edited rule in place of the running one, without restarting the plugin or other rules. The REST API that delivers edits is not yet implemented (see below).

| Edit | Effect on an active alert |
|---|---|
| signal (paths, sources, combinator, `angular`), gates, `latching`, detector `type`; a match's `op` or `value`; `direction`; an accumulator's `measure`, `while` or `resetOn`; a count's or absence's `event` | cleared, and the rule restarts from nothing; it raises again once its condition holds |
| limits (a fixed value, or a zone limit's `level` or `path`), `duration`, `clearDuration`, `hysteresis`, `window`, `horizon`, `within`, a count's or accumulator's `limit` | re-evaluated in place; timers and windows are kept, and the current value is checked against the new limit before any timer counts |
| `message`, `priority` | sent with the next emission; core decides whether it re-alerts |
| delete | cleared |

A restarted accumulator keeps its total when its `measure` is unchanged.

## Resource bounds

| Bound | Value |
|---|---|
| rules loaded | 500 |
| instances per wildcard signal | 64 |
| gates per rule | 8 |
| combinator inputs | 16 |
| durations, windows, horizons | at most 24 h; windows and horizons above 0 |
| points kept per slope or projection window | decimated to a spacing of `window`/256; at most 1024, including gap markers |
| slug | 64 characters |
| `name`, `message` | 200 and 500 characters |
| signal path, alert path | 255 characters |
| ruleset parameters | 32 |

## Status

For each rule SKAR keeps a status: issues (such as a rejected instance or an evaluation error) and, per instance, whether its alert is active, whether the rule is in use, whether the input has a value, is unavailable or has never been seen, whether the alert was adopted, whether a gate input is unavailable, the zone level and priority of an active alert, whether the alert is awaiting input, and why the rule is inactive when it cannot evaluate (a zone level missing, a timeout rule the server can never time out). An error in one rule is recorded in its status and does not stop the others.

## Worked examples

Each rule in [`examples/rules`](../examples/rules) runs in `test/examples.test.ts` against the scenario of the same name in `test/fixtures/example-scenarios.ts`, from a plugin start at 0 s. The table summarises the sequence the test asserts, with heartbeats left out. Alert paths are under `alerts.rules.user.`.

| Example | Rule | Scenario | Alerts |
|---|---|---|---|
| `house-battery-low` | Sustained below the house battery's `warn` zone for 60 s, clearing 0.2 V above it after 30 s; escalates through `alarm`. | Zones: `warn` 11.5-12 V, `alarm` below 11.5 V. 12.6 V, 11.8 V at 10 s, 11.3 V at 100 s, 12.1 V at 200 s, 12.4 V at 300 s. | 70 s raise warning; 160 s priority alarm; 230 s priority warning; 330 s clear. 12.1 V at 200 s leaves `alarm` but is inside the 0.2 V hysteresis of `warn`. |
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

The plan (issue 1) has decided the following; later units implement them. Until the store lands, the plugin loads no rules and evaluates nothing.

- **Store and REST API** ([Unit 7](https://github.com/hatlabs/signalk-alert-rules/issues/8)): rules stored in SKAR's data directory behind SKAR's own admin-only REST API, applied per rule without restarting the plugin; accumulator totals persisted, checkpointed every 60 s and on stop; a status route reporting each instance's live values and time beyond the limit; how an edit of a zone limit's named level reaches an active alert.
- **Enable and suppression** ([Unit 8](https://github.com/hatlabs/signalk-alert-rules/issues/9)): per-rule enable, suppression per rule and per input path with a note, ending manually or after the alert clears, recording the acting user; disabling, suppressing and accumulator reset clear the rule's alert; a gate whose input is suppressed keeps its last state; clearing all of SKAR's alerts together with disabling evaluation.
- **Rulesets** ([Unit 9](https://github.com/hatlabs/signalk-alert-rules/issues/10)): discovery from installed packages (keyword `signalk-alert-ruleset`) and a drop-in directory, YAML files, rulesets starting disabled, user overrides that survive upgrades, a rule inactive while its paths are missing, and an upgrade that removes a rule clearing its alert.
- **Panel** ([Unit 12](https://github.com/hatlabs/signalk-alert-rules/issues/13), [Unit 13](https://github.com/hatlabs/signalk-alert-rules/issues/14)): a confirmation before any edit that clears an active alert, and a link from the alert to its rule, under a documented key in alert data.
- **Zone and timeout proposals** ([Unit 10](https://github.com/hatlabs/signalk-alert-rules/issues/11), after the MVP).
