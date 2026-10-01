# Rulesets

A ruleset is a set of parameterised [rules](rules.md) that another npm package, or the user, provides to SKAR. It is the contract for third-party providers: a package describing some hardware can ship the alert rules that suit it, and the operator enables and tunes them without writing rules. SKAR reads a ruleset as data. It never requires, imports or runs anything in the providing package.

[`examples/ruleset-example`](../examples/ruleset-example) is a complete provider package.

## Shipping a ruleset

### In a package

A provider package declares its ruleset in `package.json`, with the keyword and a field of the same name naming the ruleset file:

```json
{
  "name": "signalk-alert-ruleset-example",
  "version": "1.0.0",
  "keywords": ["signalk-alert-ruleset"],
  "signalk-alert-ruleset": "ruleset.yaml"
}
```

- The package needs a `name` and a `version`; the operator sees both on every rule of the ruleset.
- The field is a path relative to the package directory. After resolving symbolic links it must stay inside the package and end in `.yaml`, `.yml` or `.json`.
- SKAR reads the packages listed as `dependencies` in the `package.json` of the Signal K server's configuration directory, from that directory's `node_modules`, scoped packages included. The server records every package it installs there and removes the entry on uninstall, so a provider installed through the server's app store, or with `npm install` in that directory, is found. A package copied into `node_modules` by hand, or installed with `--no-save`, is not; neither is one nested in another package's own `node_modules`. A listed package that is not installed is skipped.

### As a file

A ruleset file placed in the `rulesets` directory of SKAR's data directory, `<config directory>/plugin-config-data/signalk-alert-rules/rulesets/`, is loaded too. Only files ending in `.yaml`, `.yml` or `.json` are read; files starting with a dot are ignored.

## The ruleset file

The file is YAML, so it can carry comments, or JSON; a JSON file parses to the same ruleset. The document is described in [Rules](rules.md#rule):

| Field | |
|---|---|
| `name` | Shown to the operator, at most 200 characters. |
| `slug` | Lowercase letters, digits and hyphens, at most 64 characters, not `user`. It is the origin of every rule in the ruleset, so their alerts' `data.rule` is `<ruleset slug>.<rule slug>`; their alert paths follow their inputs, as [Alert paths](rules.md#alert-paths) describes. |
| `version` | Shown to the operator, and named in upgrade notices. |
| `description` | Optional. |
| `parameters` | Optional, at most 32. |
| `rules` | At most 500 rules, each a rule as in [Rules](rules.md#rule) with a slug unique in the ruleset. |

A parameter has a `name` (a letter, then letters, digits and underscores), a `type` of `number` or `string`, a `default`, and optionally `description`, `unit` (the SI unit of a number parameter) and, for a number, `minimum` and `maximum`. A rule uses a number parameter as `{ "param": "<name>" }` wherever a number goes, and a string parameter as `${name}` inside a path, so a provider whose path prefix is configurable can ship one ruleset:

```yaml
parameters:
  - name: prefix
    type: string
    default: electrical.batteries.house
  - name: lowVoltage
    type: number
    unit: V
    default: 12
    minimum: 10
    maximum: 14
rules:
  - name: Battery low
    slug: low
    message: Battery voltage low
    priority: warning
    signal:
      path: ${prefix}.voltage
    detector:
      type: sustained
      direction: below
      limit: { kind: fixed, value: { param: lowVoltage } }
      duration: 60
```

Parsing and validation:

- YAML is read with the YAML 1.2 core schema, so `on`, `yes`, `no` and `stopped` stay strings; where a rule needs a boolean, a string is reported as an error rather than read as `true` or `false`.
- Keys must be unique. Custom tags are rejected. Aliases may be used, but alias expansion is capped at 100, and a file is at most 1 MiB.
- Every rule is validated with the parameters at their defaults. A ruleset with any error is not loaded; none of its rules run.
- Of two rulesets with the same slug, the one found first loads: packages before files, each in name order. The other is reported as malformed.

A ruleset that cannot be loaded is listed with the reason, and for a YAML error its line, in `GET /rulesets` (see [REST API](api.md#rulesets)); the others load as usual.

## What the operator does with it

- **Discovery.** Rulesets are discovered when the plugin starts and when the operator asks for a rescan. A rescan applies what changed and leaves the rules that did not change running. When the settings or totals discovery changes cannot be written at start, as on a full disk, every rule still runs with them and the plugin status names the failure until they are written: the settings by the next change that saves them, the totals by the next checkpoint. A rescan that cannot write them fails.
- **Enable.** A newly discovered ruleset starts disabled. Enabling it starts each of its rules; the operator can still disable a single rule. Disabling it clears its rules' alerts.
- **Parameters.** The operator sets parameter values within the declared type and bounds; parameters left unset take their defaults. A change edits only the rules it changes, with the [edit semantics](rules.md#edits) of a user rule: a changed path restarts the rule, a changed limit or duration is applied in place.
- **Read-only rules.** The operator cannot edit a ruleset rule's detector, limits or message. The parameters are the tuning surface a provider offers; an operator who needs a different rule copies it as a user rule.
- **Controls.** A ruleset rule takes the same controls as a user rule, keyed by its id `<ruleset slug>.<rule slug>`: enable, note, suppression and accumulator reset.

## Missing paths

A ruleset describes hardware that may not be on the boat. A rule of an enabled ruleset stays `inactive`, with the reason `ruleset path missing`, until the server has had every path it reads since the plugin started: its signal's path or combinator inputs and its gates' paths, after parameter substitution. A wildcard path needs one matching path. Until then the rule raises nothing, including absence and timeout alerts, and the ruleset lists the missing paths. Once all its paths have appeared the rule starts at the next evaluation tick, and it does not go back to inactive until the plugin restarts, even if the paths fall silent. That holds for the paths it was checked with: when a parameter change, an upgrade or the ruleset's return changes the paths a rule reads, the rule is checked again, and a running rule pointed at a path the server has not had goes back to inactive at once, clearing its alerts. A rule whose alert core holds when the plugin starts counts as present with the paths it reads then, so a restart does not clear the alert before its paths report again.

## Upgrades

When a ruleset loads with a different content, at start or on a rescan, the operator's settings are carried over by rule slug:

- A rule whose slug survives keeps its controls: enabled or disabled, note, suppression and accumulator total. If its resolved form changed, it is edited with the usual edit semantics. An upgrade installed while the plugin was stopped, and a ruleset that returns after it was uninstalled, drop an accumulator total whose measure changed and the gate states an input suppression froze for gates that changed, as an edit does: each saved total records the measure it was built under, and the ruleset settings record each rule's gates beside the frozen states.
- A rule whose slug is gone has its alert cleared and its controls dropped.
- A stored parameter value that no longer validates, because the parameter is gone, changed type or has new bounds, is dropped and its default applies. If the remaining values no longer make valid rules, all of them are dropped.

Each dropped rule and value adds a notice to the ruleset, kept until the operator dismisses it. Keep rule slugs stable across versions: renaming a rule is removing one and adding another.

A ruleset that no longer loads, because its package was uninstalled, its file removed, or a new version does not validate, stops its rules and clears their alerts. The operator's settings for it are kept, and apply again if it comes back.
