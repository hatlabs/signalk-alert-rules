# Templates

A template is a [rule](rules.md) with parts left open: its slots, each a path segment that tells one battery bank or engine from another, or its input's source, or both. Using a template means picking what is open; the result is an ordinary rule with the picks filled in. Templates come in template sets: one is built into Alert Rules, and other npm packages, or the user, can provide more. A package describing some equipment can ship the alert rules that suit it, and the user adds them to the boat without writing rules.

Alert Rules reads a template set as data. It never requires, imports or runs anything in the providing package. [`examples/template-set-example`](../examples/template-set-example) is a complete provider package, and [`templates/builtin.yaml`](../templates/builtin.yaml) is the built-in set.

## Shipping a template set

### In a package

A provider package declares its template set in `package.json`, with the keyword and a field of the same name naming the template set file:

```json
{
  "name": "signalk-alert-templates-example",
  "version": "1.0.0",
  "keywords": ["signalk-alert-templates"],
  "signalk-alert-templates": "templates.yaml"
}
```

- The package needs a `name` and a `version`; `GET /templates` reports both with the set.
- The field is a path relative to the package directory. After resolving symbolic links it must stay inside the package and end in `.yaml`, `.yml` or `.json`.
- Alert Rules reads the packages listed as `dependencies` in the `package.json` of the Signal K server's configuration directory, from that directory's `node_modules`, scoped packages included. The server records every package it installs there and removes the entry on uninstall, and `npm install <package>` run in that directory records it too. A package copied into `node_modules` by hand, or installed with `--no-save`, is not found; neither is one nested in another package's own `node_modules`. A listed package that is not installed is skipped.

The server's app store lists and installs only Signal K plugins and webapps, packages with the keyword `signalk-node-server-plugin`, `signalk-webapp` or `signalk-embeddable-webapp`. A plugin or webapp can ship a template set as well, and is then installed from the app store as usual. A package that ships only a template set is not in the app store: install it with `npm install <package>` in the server's configuration directory.

### As a file

A template set file placed in the `templates` directory of the plugin's data directory, `<config directory>/plugin-config-data/signalk-alert-rules/templates/`, is loaded too. Only files ending in `.yaml`, `.yml` or `.json` are read; files starting with a dot are ignored.

### Discovery

Template sets are discovered each time the webapp lists them, so a set installed, updated or removed shows up without restarting the plugin. The built-in set comes first, then packages and then files, each in name order. Of two sets with the same `id`, the one found first loads and the other is reported as a problem, so no other set can take the built-in set's id `builtin`.

A set that cannot be loaded is listed with the reason in `GET /templates` (see [REST API](api.md#templates)): for a YAML error with its line, and for a set that does not validate with each error and its JSON pointer into the set. The others load as usual.

## The template set file

The file is YAML, so it can carry comments, or JSON; a JSON file parses to the same set.

| Field | |
|---|---|
| `name` | Shown to the user, 1-200 characters. |
| `id` | Lowercase letters and digits separated by single hyphens, at most 64 characters. Recorded on every rule made from the set. |
| `version` | 1-64 characters. Recorded on every rule made from the set. |
| `description` | Optional, at most 1000 characters. |
| `templates` | At most 500 templates. |

A template:

| Field | |
|---|---|
| `id` | Lowercase letters and digits separated by single hyphens, at most 64 characters, unique in the set. Keep it stable across versions: the notice of new templates goes by it (see [New-template notices](#new-template-notices)). |
| `description` | Optional, at most 1000 characters; shown when the user picks a template. |
| `slots` | Optional: the template's slots, at most 4, each a `name` and a `label`; see [Slots](#slots). |
| `open` | Optional: `instance`, `source` or both. `instance` declares the one slot `instance` (see [`open: [instance]`](#open-instance)) and cannot be combined with `slots`; `source` leaves the source open (see [Open source](#open-source)). With neither `slots` nor `open`, the template is fully bound and makes one rule as written. |
| `condition` | Optional: the condition name of the rules it makes, the last segment of their [alert path](rules.md#alert-paths). It may carry slots. Required where a rule needs one: for a combined signal, and for an input path ending in a wildcard. |
| `rule` | A rule as in [Rules](rules.md#rule), without `slug`, `condition` and `template`: those are set when the template is used. |

```yaml
name: Example equipment
id: example
version: 1.0.0
templates:
  # An open instance: the user picks which battery bank the rule watches.
  # ${instance} stands for that one path segment, and is filled in wherever
  # it appears in the rule's paths, name and message.
  - id: battery-discharge-high
    description: >-
      A battery bank discharges at more than 100 A for 30 seconds, a warning,
      and climbs to an alarm above 150 A.
    open: [instance]
    # The last segment of the alert path, under electrical.batteries.<pick>.
    condition: dischargeHigh
    rule:
      name: Battery ${instance} discharging hard
      # {limit} and {value} are filled in each time the alert is sent.
      message: 'Battery ${instance} discharge beyond {limit}: {value}'
      signal:
        path: electrical.batteries.${instance}.current
      detector:
        type: sustained
        direction: below
        # A discharge is a negative current, in amperes.
        steps:
          - { limit: -100, priority: warning }
          - { limit: -150, priority: alarm }
        duration: 30
        hysteresis: 5
```

Every number is in SI units, as in any rule, and every limit is a starting point the user adjusts when using the template.

### Slots

A slot is a path segment the user picks, written `${<name>}` in the template's rule. A template declares its slots under `slots`, in order. The built-in "alternator not charging" template has two, a battery it watches and an engine whose revolutions gate it:

```yaml
  - id: alternator-not-charging
    slots:
      - { name: battery, label: Battery }
      - { name: engine, label: Engine }
    condition: ${engine}AlternatorNotCharging
    rule:
      name: Engine ${engine} alternator not charging
      # description and message left out
      signal:
        path: electrical.batteries.${battery}.voltage
      detector:
        type: sustained
        direction: below
        steps:
          - { limit: 13.0, priority: warning }
        duration: 120
      gates:
        - signal:
            path: propulsion.${engine}.revolutions
          direction: above
          limit: { kind: fixed, value: 8 }
          duration: 30
```

Picking the battery `start` and the engine `main` makes the rule `Engine main alternator not charging`, which watches `electrical.batteries.start.voltage` while `propulsion.main.revolutions` is above 8 Hz, and alerts at `alerts.electrical.batteries.start.mainAlternatorNotCharging`.

- A slot's `name` is a letter followed by letters and digits, at most 32 characters, unique in the template. `source` is reserved for the open source. The name keys the slot's pick in the rule's [template record](#using-a-template).
- A slot's `label` names what is picked, such as `Battery`: 1-40 characters, unique in the template. The webapp shows it where the slot is picked.
- A template declares at most 4 slots.
- Every slot appears in at least one path. In a path, a slot's placeholder is a whole path segment: `electrical.batteries.${battery}.voltage`, not `electrical.batteries.bank${battery}.voltage`.
- Placeholders are filled in in the rule's paths, its name and its message, and in the template's `condition`. Any other `${...}`, including `${instance}` when no slot is named `instance`, is an error.
- A template with `slots` cannot have `instance` in `open`; it can leave the source open as well.

Using the template replaces every placeholder with its slot's pick: in the signal's path or the paths of a combined signal's inputs, gates' paths, a zone limit's path, the name, the message and the condition. In the condition, each character of a pick other than a letter, a digit, `_` or `-` becomes `_`, so the condition name stays one alert path segment.

Each slot must reach the rule's [alert path](rules.md#alert-paths), the condition name under the parent the signal gives, so that two picks make two alert paths. A slot reaches it through the signal path's parent segments or through the condition name: the template's, or the default one taken from the signal path's last segment. Unless the condition name carries it, a slot that only a gate or a zone limit uses, a slot only in a combined signal's inputs below their common parent, or a slot only in the signal path's last segment gives every pick the same alert path. The first rule made from such a template is created; a second one with another pick for that slot is refused, as any rule whose alert path overlaps another's. The alternator template's engine is in a gate only, so its condition carries `${engine}`: two engines charging one battery get two alerts. Validation uses one sample pick (see [Validation](#validation)) and cannot detect a slot that does not reach the alert path.

Alert Rules accepts `slots` from version 0.1.0, its first published version.

### `open: [instance]`

`open: [instance]` declares one slot named `instance`, labelled Instance, a shorter way to write a template with a single slot. The rules for slots apply to it, except that `${instance}` is not checked to be a whole path segment; write it as one. `${instance}` anywhere needs `instance` in `open`, and an open instance needs `${instance}` in at least one path. A combined signal whose inputs all carry `${instance}` reads one instance, such as the voltage and the current of the same battery bank.

### Field paths and picks

- A template's paths may address a [field of an object value](rules.md#fields-of-object-values), such as `navigation.attitude#/roll`. A slot's placeholder may end the base path, as in `electrical.batteries.${instance}#/voltage`, but cannot appear after `#`, in the pointer: the template names the field.
- A pick is one path segment: no dots, no whitespace, no `*`, no `#`, at most 255 characters.

### Open source

With `source` in `open`, the user picks which `$source` the rule reads, such as one of two depth sounders, and the rule reads only that source, whatever its rank (see [Signals](rules.md#signals)). The picked source is set on the rule's signal, so an open source needs a signal with a single path, not a combined signal. A template with both slots and an open source takes a source of the signal path its picks make.

### Message placeholders

A template's message can carry two kinds of placeholder, filled in at different times:

- A slot's placeholder, such as `${instance}`, is filled in once, when the template is used, and the rule stores the result: `Battery ${instance} discharge` becomes `Battery house discharge`.
- `{limit}`, `{duration}`, `{value}` and `{instance}` stay in the stored rule and are filled in each time the alert is sent, as [Messages](rules.md#messages) describes. `{instance}` there is a wildcard instance's name, not a pick: a template's message names its picks with slot placeholders.

### Validation

YAML is read with the YAML 1.2 core schema, so `on`, `yes`, `no` and `stopped` stay strings; where a rule needs a boolean, a string is reported as an error rather than read as `true` or `false`. Keys must be unique. Custom tags are rejected. Aliases may be used, but alias expansion is capped at 100, and a file is at most 1 MiB.

Each template is checked on its own, then used with one sample pick, the same for every slot and the source, and the rule it makes is validated as any rule. The template's condition is checked as a condition name once the sample pick fills its slots. A set with any error is not loaded; none of its templates is offered.

## Using a template

In the webapp, Add rule offers the template sets and their templates. How a template is picked depends on its number of slots.

A template with at most one slot is picked from a checkbox list of what reports now. For a slot in the signal path, the list has each instance that reports under that path; for a slot only in gate or zone limit paths, each instance that reports one of those. With the source open, each source of an instance's signal path is its own entry. While the source is not open, an instance that does not report yet can be typed under "Not listed?". Each checked entry makes a rule.

A template with two or more slots is picked in rows, one rule per row, with a select for each slot and, when the template leaves the source open, one for the source:

- A slot's choices are the instances that report any path the slot is in: the signal's path or a combined signal's inputs, gates' paths and a zone limit's path. Each choice shows the value of the first of those paths it reports, the signal's first.
- When the paths are first read, each slot that exactly one instance reports is filled in, in every row where it is still empty; "Add another" adds a row filled in the same way. Later reads never change a pick already made, and a pick nothing reports any more stays among the choices, marked "not reporting".
- Under the rows, "<label> not listed?" takes a name for each slot, for an instance that does not report yet. The name joins that slot's choices in every row and fills each row where the slot is empty. While the template leaves the source open, a slot in the signal path has no such entry, since an instance that does not report has no sources to pick.
- The source select lists the sources of the signal path the row's picks make. It waits until the slots in the signal path are chosen, and clears when one of them changes.
- Continue needs every slot and the source chosen in every row, and no two rows the same. Until then the line above it names the first slot or source left unchosen in row order, such as "Choose an engine for rule 2", and once none is, the first two rows that are the same, such as "Rules 1 and 2 are the same".

A pick that already has a rule from the same template is marked with that rule's name. For a template with no slot, or whose one slot is in the signal path, that is a rule from the template watching the path the pick makes, from the same source; for any other template, a rule whose stored `pick` record holds the same picks, every slot and the source included. The picks make the rules, edited in a tab each and created with one save; a marked pick's tab is left out of the save unless "Create another rule for it" is chosen there. A row's tab is labelled with its picks joined by " · ", in slot order, the source last.

Each use makes an ordinary rule:

- Its slug is the template's id followed by each slot's pick in slot order, such as `battery-discharge-high-house` or `alternator-not-charging-start-main`, shortened to 64 characters and numbered when another rule has it.
- It stores the template's condition name with the picks filled in, so two rules from one template with the same picks have the same alert path, and the second is refused until it is given another condition name (see [Alert paths](rules.md#alert-paths)).
- A picked source is stored in its canonical form where the device has one, as for any rule.
- It records where it came from, in its `template` field: the set's `id` and `version`, the template's `id`, and the `pick` record, each slot's pick under the slot's name and the picked source under `source`, such as `{ "battery": "start", "engine": "main" }` or, for a template written with `open: [instance]`, `{ "instance": "house" }`. The `pick` record has no `instance` unless a slot is named so. The record is information only. Nothing reads it to evaluate the rule, and a later version of the template, or its removal, never changes a rule already made.

A template set never creates or enables a rule by itself, a fully bound template included: rules are made only when someone uses a template.

## New-template notices

The webapp announces templates nobody has seen yet, by set, at the top of the rule list, with a link to them. The notice is shown to administrators, who can dismiss it; a dismissal is stored on the server and applies to every user.

- A dismissal records the ids of the templates the notice showed, by set id. A template installed after the notice was drawn stays new and is announced in turn.
- A new version of a set announces only the templates whose ids are new. Renaming a template's id announces it again.
- A template stays dismissed while its set is uninstalled or fails to load, so a broken update followed by a fixed one raises no notice.
