# REST API

SKAR serves its rules, their status and its operator actions under the plugin's route on the Signal K server, `/plugins/signalk-alert-rules`. The Alert Rules webapp is its client. Bodies are JSON; values are in SI units, as in [the rule model](rules.md).

## Security

- While server security is enabled, each route admits the access level the routes table gives and every level above it: read-only users read rules, states, templates and the action log, read/write users also disable and enable rules, and everything else is admin-only. A Signal K server older than 2.31 cannot open plugin routes to lower levels; there every route is admin-only, and the plugin status says so.
- With the server's Allow Readonly Access on, a request without a login is a read-only user: anyone who can reach the server reads every read-only route, including the action log's actors and notes, a disabled rule's actor and note, and the server paths named in template problems and plugin issues.
- With security disabled, anyone who can reach the server can use every route. `GET /state` reports `securityEnabled: false` so the webapp can show a persistent warning.
- Every `POST`, `PUT` and `DELETE` must carry `Content-Type: application/json`, including those without a body; anything else is refused with 415. A browser does not send that content type to another site without asking the site first, so a page elsewhere cannot act through an admin's session.
- Deletes, accumulator resets, enables, disables, notes, suppressions and ruleset changes record the actor: the authenticated user's id, or `unauthenticated` when there is none.

## Routes

| Route | Level | Does |
|---|---|---|
| `GET /state` | read-only | the plugin's state (below); answers while the plugin is not running |
| `GET /rules` | read-only | every rule, as rule entries |
| `GET /rules/:slug` | read-only | one rule entry |
| `POST /rules` | admin | creates a rule from the body; 201 with its entry |
| `PUT /rules/:slug` | admin | replaces a rule with the body; the body's `slug` must equal the path's |
| `POST /rules/:slug/preview` | admin | what replacing the rule with the body would do, without doing it |
| `DELETE /rules/:slug` | admin | deletes a rule and clears its alerts; 204 |
| `POST /rules/:slug/reset` | admin | resets an accumulator rule; answers its entry |
| `POST /rules/:slug/disable` | read/write | disables a rule, with an optional `{ "note": "..." }`; answers its entry |
| `POST /rules/:slug/enable` | read/write | enables a rule; answers its entry |
| `GET /log` | read-only | the operator action log, newest first |
| `GET /templates` | read-only | the template sets installed now, each with its templates and the ids of those whose notice nobody has dismissed, and the sets that failed to load |
| `POST /templates/dismiss` | admin | dismisses the notice of every template installed now; answers as `GET /templates` |

The level is the lowest access level a route admits while server security is enabled.

Rules are stored in the plugin's data directory, one file per rule as `rules/<slug>.json`, and validated at start; one that does not run is listed as an [invalid rule entry](#invalid-rule-entry) and named in the server's plugin status.

### Rule entry

```json
{
  "slug": "oil-pressure-low",
  "rule": { ... },
  "alertPath": "propulsion.main.oilPressureLow",
  "disabled": { "since": "2026-09-30T12:00:00.000Z", "actor": "admin", "note": "Sender replaced in spring" },
  "state": { ... }
}
```

- `slug`: the rule's slug, as in its body.
- `rule`: the rule as stored.
- `alertPath`: the rule's alert path without the `alerts.` prefix, its condition name under the parent its input gives, as [Alert paths](rules.md#alert-paths) describes. It is derived, not part of the rule; a wildcard rule's has a `*` where each instance's segment goes.
- `disabled`: present while the rule is disabled: when, by whom and, when given, why; see [Rule controls](#rule-controls).
- `state`: the rule's state: `ruleState` (`enabled` or `disabled`), its `condition` with a `reason` code and that reason's facts, `changedAt`, the time either last changed since the plugin started (an adopted alert keeps its raise time), `issues` and `errors`, and one row per instance, as described in [State](rules.md#state). While the plugin has not started evaluating, the condition is `noData` with the reason `notEvaluated`, and the rule's accumulator totals are instance rows with `progress`.

### Invalid rule entry

A stored rule file that was read but does not run is listed in `GET /rules`, after the rules that run, and answered by `GET /rules/:slug`:

```json
{
  "slug": "coolant-high",
  "invalid": {
    "errors": [{ "path": "/detector/steps/0/priority", "message": "..." }],
    "body": { ... }
  },
  "state": { "ruleState": "enabled", "condition": "problem", "reason": "invalidRule", "changedAt": "2026-09-30T12:00:00.000Z", "issues": [], "errors": [], "instances": [] }
}
```

- `invalid.errors`: why it does not run, as `{ "path", "message" }` with a JSON pointer into `body`: a rule that does not validate, a `slug` other than the one in its file name (at `/slug`), or an alert path overlapping that of a rule loaded before it (at `/condition`).
- `invalid.body`: the stored file's content as read.
- `disabled`: as for a rule entry, present while the rule is disabled.
- `state`: the condition `problem` with the reason `invalidRule`, dated from when the plugin loaded the stored rules.

A `PUT` of a valid rule with its slug replaces the file and starts the rule; a `DELETE` removes it.

### Edit preview

```json
{
  "restarts": true,
  "changes": ["detector.type"],
  "activeAlerts": 1,
  "clearsActiveAlert": true,
  "discardsTotal": false
}
```

- `restarts`: the edit clears and restarts the rule, per the [edit semantics](rules.md#edits). Any edit restarts a rule that failed to start.
- `changes`: the parts of the rule that make it restart, by field path: `alertPath`, `signal`, `gates`, `latching`, `detector.limit` (a switch between steps and a zone limit), `detector.limit.level` (a zone limit's level), `detector.steps.value` (a match's step values), or `detector.<field>`. `alertPath` means the rule's [alert path](rules.md#alert-paths) moves, through its condition name or through an input or detector edit that changes the default name or the parent; the alert at the old path is cleared.
- `activeAlerts`: how many of the rule's instances have an active alert now.
- `clearsActiveAlert`: the edit restarts the rule while it has an active alert, so saving it clears that alert; the webapp asks for confirmation. It counts only clears the restart causes: an edit applied in place, for example a raised limit, can also clear an active alert at the next evaluation, when the current value no longer meets the condition.
- `discardsTotal`: the rule has an accumulator total above zero, running or kept while it does not run, and saving the edit would discard it: the edit is no longer an accumulator of the same measure. Replacing a stored rule that failed validation keeps its total when both the stored file and the new rule are accumulators of the same measure.

The preview uses the same comparison the engine applies when the edit is saved.

### Rule controls

The rule behaviour behind these routes is in [Enable and suppression](rules.md#enable-and-suppression). Controls and suppressions persist in the data directory and survive restarts.

- Disabling a rule clears its alerts and raises nothing while it keeps evaluating; enabling it raises at once when its state shows the condition `present`, and otherwise once its condition has held for its duration. Setting the current value changes nothing and is not logged.
- A note is at most 500 characters. Setting the note a rule already has changes nothing and is not logged.
- A suppression request body is an object with optional fields: `note`, at most 500 characters, and `autoEndAfter`, seconds above 0 and at most 86400. Without `autoEndAfter` the suppression ends only through `DELETE`. Other fields are refused.
- Suppressing clears the active alerts it suppresses; ending it raises an alert whose condition still holds as a new alert. Ending a suppression that is not in force, such as one that has just ended by itself, changes nothing, is not logged and answers 204.
- An input path must be exact: dot-separated segments, no wildcard, at most 255 characters.

A suppression, as `GET /suppressions` lists it and `PUT /suppressions/inputs/:path` answers it:

```json
[
  {
    "scope": "input",
    "path": "propulsion.port.revolutions",
    "since": "2026-09-30T12:05:00.000Z",
    "actor": "admin",
    "note": "Tachometer sender faulty"
  },
  {
    "scope": "rule",
    "rule": "user.oil-pressure-low",
    "origin": "user",
    "slug": "oil-pressure-low",
    "since": "2026-09-30T12:00:00.000Z",
    "actor": "admin",
    "autoEndAfter": 600
  }
]
```

An input suppression preview:

```json
{
  "path": "propulsion.port.revolutions",
  "suppresses": [
    { "rule": "user.rpm-high", "origin": "user", "slug": "rpm-high" },
    { "rule": "user.rpm-high-each", "origin": "user", "slug": "rpm-high-each", "instance": "port" }
  ],
  "freezes": [
    {
      "rule": "user.coolant-high",
      "origin": "user",
      "slug": "coolant-high",
      "gate": 0,
      "states": [{ "holds": true }]
    }
  ]
}
```

- A rule is named by its id, `rule`, and by the `origin` and `slug` it is made of, as in the rule routes; so is a rule suppression.
- `suppresses`: the rules whose signal or combinator reads the path, with the wildcard instance that does.
- `freezes`: per gate that reads the path, by its index in the rule's `gates`, the state each instance of the rule would be frozen at: `instance` for a wildcard rule, and `holds`. `states` is empty for a rule that is not evaluated or has no instance yet. Suppressing the path stores these states and freezes the gates at them; see [Input suppression](rules.md#input-suppression).

### Rulesets

Rulesets are described in [Rulesets](rulesets.md). `GET /rulesets` answers:

```json
{
  "rulesets": [
    {
      "slug": "batteries",
      "name": "Battery monitoring",
      "version": "1.0.0",
      "source": "package signalk-alert-ruleset-example",
      "package": { "name": "signalk-alert-ruleset-example", "version": "1.0.0" },
      "enabled": false,
      "parameters": [{ "name": "lowVoltage", "type": "number", "unit": "V", "default": 12, "minimum": 10, "maximum": 14 }],
      "values": { "lowVoltage": 11.5 },
      "rules": ["low"],
      "missingPaths": ["electrical.batteries.house.voltage"],
      "notices": [{ "at": "2026-09-30T12:00:00.000Z", "message": "rule high is not in version 1.0.0: its alert was cleared and its settings dropped" }]
    }
  ],
  "problems": [{ "source": "file broken.yaml", "message": "Flow sequence in block collection must be sufficiently indented and end with a ] at line 3, column 1", "line": 3 }]
}
```

- `source`: where the ruleset was found, `package <name>` or `file <name>` for a file in the drop-in directory; `package` and `description` are absent when there is none.
- `parameters`: the ruleset's declarations; `values`: the values the operator set, the rest taking their defaults.
- `missingPaths`: the paths its rules read that the server has not had since the plugin started. Its rules stay inactive until theirs appear.
- `notices`: what an upgrade changed, kept until dismissed: a removed rule, and a stored parameter value dropped because it no longer validates.
- `problems`: the rulesets that could not be loaded, with the reason and, for a YAML error, its line. A message may name the absolute path of a file on the server; the routes are admin-only.
- A new ruleset starts disabled. Enabling or disabling a ruleset starts or stops each of its rules that is enabled itself. Setting the current value changes nothing and is not logged.
- A parameter change edits only the rules whose resolved form changes, with the [edit semantics](rules.md#edits) of a user rule. A value must be declared by the ruleset, of the parameter's type and within its bounds, and the rules it makes must validate; otherwise the request answers 400 and nothing changes. An error in a value points at `/<name>` in the body; an error in a rule the values make points at the body itself, `""`, and its message names the rule and the field, as in `rule low /signal/path: …`. Setting the values the ruleset has changes nothing and is not logged.
- A rescan applies an upgrade as a start would and leaves the rules that did not change running untouched. Unlike a start, a rescan whose settings cannot be written answers 500.

### Accumulator reset

A reset clears the rule's active alerts and sets its total to zero: the running total, one restored at start, and the checkpoint in the data directory. The rule goes on accumulating from zero. A rule that is not an accumulator answers 400.

### Action log

The last 200 actions, newest first, kept in the data directory:

```json
[
  { "at": "2026-09-30T12:01:00.000Z", "actor": "admin", "action": "reset", "rule": "user.engine-hours" },
  { "at": "2026-09-30T12:00:00.000Z", "actor": "admin", "action": "delete", "rule": "user.oil-pressure-low" }
]
```

- `action` is `delete`, `reset`, `enable`, `disable` or `note` with `rule`; `suppress` or `unsuppress` with `rule` or `path`; `enable`, `disable`, `parameters` or `dismiss` with `ruleset`, the ruleset's slug; or `rescan`.
- `rule` is `<origin>.<slug>`.
- A suppression that ends by itself is logged as `unsuppress` with the actor `auto-end`.

### Plugin state

```json
{
  "running": true,
  "securityEnabled": true,
  "permissions": "readwrite",
  "issues": []
}
```

- `running`: whether the plugin is running. While it is not, every other route answers 503.
- `error`: why the plugin did not start, such as a server without the alerts API, or accumulator totals or an action log that could not be read from the data directory.
- `securityEnabled`: whether the server enforces security; `null` when SKAR cannot tell.
- `permissions`: the caller's access level, `readonly`, `readwrite` or `admin`, which tells the webapp which controls to offer. With security disabled it is `admin`, since every caller can use every route. A level the server reports that SKAR does not know reads as `readonly`.
- `issues`, while running: the problems found while loading the data directory, such as a stored rule file that cannot be read or parsed. Such a rule is not listed in `GET /rules`; it can be replaced with `PUT` or deleted. A stored rule that is read but does not run is not an issue: it is listed as an [invalid rule entry](#invalid-rule-entry).

### Rule links

The Alert Rules webapp opens a rule's detail view from a link, such as one an alert carries. The admin UI routes with its own hash, so the rule rides as a second fragment after the webapp's route, `#/e/signalk_alert_rules`, which is the route the admin UI's Webapps page opens:

```
/admin/#/e/signalk_alert_rules#rule=<slug>
```

A link to one instance of a wildcard rule adds the instance:

```
/admin/#/e/signalk_alert_rules#rule=<slug>&instance=<name>
```

- The slug and the instance are each percent-encoded as `encodeURIComponent` does.
- The instance is its name, the path segment the rule's wildcard matched, or its segment in the alert path, where the rule's alert path has its `*`. A consumer building the link from an alert takes the slug from the alert's `data.rule` and the instance from the alert path's segment at the rule's `*`. The detail view highlights that instance's row, and moves focus to it when the webapp is already open.
- A link to a rule that is not listed, such as one that was deleted, opens the rule list with a notice that the rule was not found. A link to an instance the rule does not have now shows the rule with a notice saying so.

The webapp's other views ride the same way: `#edit=<slug>` opens a rule in the editor, `#add` opens Add rule, and `#add=template` and `#add=path` its two ways to start. A fragment the webapp does not know opens the rule list.

## Errors

Errors answer `{ "error": "<message>" }`. A body that fails validation answers 400 and adds `errors`, a list of `{ "path", "message" }` with a JSON pointer to each offending field.

| Status | When |
|---|---|
| 400 | invalid body; an input path that is not exact; a `PUT` or preview whose `slug` differs from the path's; a reset of a rule that is not an accumulator |
| 404 | no such rule or ruleset |
| 409 | `POST /rules` with a slug a stored rule already has; a create, replace or preview whose rule's [alert path](rules.md#alert-paths) overlaps another rule's, with an error at `/condition` |
| 415 | a mutating request without `Content-Type: application/json` |
| 500 | the data directory could not be written. A rule or deletion that could not be saved is not applied. A reset, or a save or deletion that discards an accumulator total, whose totals could not be saved has been applied, but the old total returns after a restart unless a later checkpoint succeeds; a reset or deletion is in the action log all the same. An action whose log entry could not be written has been applied. A deletion whose controls could not be removed has deleted the rule, and a rule later created with its slug takes those controls. |
| 503 | the plugin is not running |
