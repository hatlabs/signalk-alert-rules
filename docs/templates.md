# Templates

A template is a [rule](rules.md) whose instance, the path segment that tells one battery bank or engine from another, or whose input's source, or both, are left open. Using a template means picking what is open; the result is an ordinary rule with the picks filled in. Templates come in template sets: one is built into Alert Rules, and other npm packages, or the user, can provide more. A package describing some equipment can ship the alert rules that suit it, and the user adds them to the boat without writing rules.

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
| `open` | Optional: `instance`, `source` or both. Left out, the template is fully bound and makes one rule as written. |
| `condition` | Optional: the condition name of the rules it makes, the last segment of their [alert path](rules.md#alert-paths). Required where a rule needs one: for a combined signal, and for an input path ending in a wildcard. |
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

### `${instance}` and an open instance

With `instance` in `open`, the template's rule writes the instance as `${instance}`. Using the template replaces every `${instance}` in the rule's paths, its name and its message with the picked instance: the signal's path or the paths of a combined signal's inputs, gates' paths and a zone limit's path. A combined signal whose inputs all carry `${instance}` reads one instance, such as the voltage and the current of the same battery bank.

- An open instance needs `${instance}` in at least one path, and `${instance}` anywhere needs `instance` in `open`.
- `${instance}` is the only placeholder substituted; any other `${...}` in a path, the name or the message is an error.
- `${instance}` is a whole path segment and cannot appear after `#`, in a field pointer such as `navigation.attitude#/roll`: the template names the field.
- A picked instance is one path segment: no dots, no whitespace, no `*`, no `#`, at most 255 characters.

### Open source

With `source` in `open`, the user picks which `$source` the rule reads, such as one of two depth sounders, and the rule reads only that source, whatever its rank (see [Signals](rules.md#signals)). The picked source is set on the rule's signal, so an open source needs a signal with a single path, not a combined signal. A template with both open takes an instance and a source of that instance's path.

### Message placeholders

A template's message can carry two kinds of placeholder, filled in at different times:

- `${instance}` is filled in once, when the template is used, and the rule stores the result: `Battery ${instance} discharge` becomes `Battery house discharge`.
- `{limit}`, `{duration}`, `{value}` and `{instance}` stay in the stored rule and are filled in each time the alert is sent, as [Messages](rules.md#messages) describes. `{instance}` there is a wildcard instance's name, so a rule made from an open instance, which has no wildcard, names its instance with `${instance}`.

### Validation

YAML is read with the YAML 1.2 core schema, so `on`, `yes`, `no` and `stopped` stay strings; where a rule needs a boolean, a string is reported as an error rather than read as `true` or `false`. Keys must be unique. Custom tags are rejected. Aliases may be used, but alias expansion is capped at 100, and a file is at most 1 MiB.

Each template is checked on its own, then used with a sample pick for each open part, and the rule it makes is validated as any rule. A set with any error is not loaded; none of its templates is offered.

## Using a template

In the webapp, Add rule offers the template sets and their templates. For an open part it lists the instances, or the sources, the server reports now under the template's path. For a template whose only open part is the instance, an instance that does not report yet can be typed. A pick that already has a rule from the same template is marked with that rule's name. Several picks make several rules, edited in a tab each and created with one save.

Each use makes an ordinary rule:

- Its slug is the template's id followed by the picked instance, such as `battery-discharge-high-house`, numbered when another rule has it.
- It stores the template's condition name, so two rules from one template on one instance have the same alert path, and the second is refused until it is given another condition name (see [Alert paths](rules.md#alert-paths)).
- A picked source is stored in its canonical form where the device has one, as for any rule.
- It records where it came from, in its `template` field: the set's `id` and `version`, the template's `id`, and the `pick`. The record is information only. Nothing reads it to evaluate the rule, and a later version of the template, or its removal, never changes a rule already made.

A template set never creates or enables a rule by itself, a fully bound template included: rules are made only when someone uses a template.

## New-template notices

The webapp announces templates nobody has seen yet, by set, at the top of the rule list, with a link to them. The notice is shown to administrators, who can dismiss it; a dismissal is stored on the server and applies to every user.

- A dismissal records the ids of the templates the notice showed, by set id. A template installed after the notice was drawn stays new and is announced in turn.
- A new version of a set announces only the templates whose ids are new. Renaming a template's id announces it again.
- A template stays dismissed while its set is uninstalled or fails to load, so a broken update followed by a fixed one raises no notice.
