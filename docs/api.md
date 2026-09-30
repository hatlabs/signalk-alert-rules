# REST API

SKAR serves its rules, their status and its operator actions under the plugin's route on the Signal K server, `/plugins/signalk-alert-rules`. The configuration panel is its client. Bodies are JSON; values are in SI units, as in [the rule model](rules.md).

## Security

- Every route is admin-only while server security is enabled: the server checks admin access for every plugin route a plugin does not open up to other access levels, and SKAR opens none.
- With security disabled, anyone who can reach the server can use every route. `GET /state` reports `securityEnabled: false` so the panel can show a persistent warning.
- Every `POST`, `PUT` and `DELETE` must carry `Content-Type: application/json`, including those without a body; anything else is refused with 415. A browser does not send that content type to another site without asking the site first, so a page elsewhere cannot act through an admin's session.
- Deletes, accumulator resets, evaluation switches, enables, disables, notes, suppressions and ruleset changes record the actor: the authenticated user's id, or `unauthenticated` when there is none.

## Routes

| Route | Does |
|---|---|
| `GET /state` | the plugin's state (below); answers while the plugin is not running |
| `GET /rules` | every rule, as rule entries |
| `GET /rules/:origin/:slug` | one rule entry |
| `POST /rules` | creates a user rule from the body; 201 with its entry |
| `PUT /rules/user/:slug` | replaces a user rule with the body; the body's `slug` must equal the path's |
| `POST /rules/user/:slug/preview` | what replacing the rule with the body would do, without doing it |
| `DELETE /rules/user/:slug` | deletes a user rule and clears its alerts; 204 |
| `POST /rules/:origin/:slug/reset` | resets an accumulator rule; answers its entry |
| `GET /evaluation` | the evaluation switch |
| `PUT /evaluation` | sets the evaluation switch from `{ "enabled": true \| false }`; answers the switch |
| `GET /log` | the operator action log, newest first |
| `PUT /rules/:origin/:slug/enabled` | enables or disables a rule from `{ "enabled": true \| false }`; answers its entry |
| `PUT /rules/:origin/:slug/note` | sets a rule's note from `{ "note": "..." }`; an empty note removes it; answers its entry |
| `GET /suppressions` | every suppression in force, newest first |
| `PUT /suppressions/rules/:origin/:slug` | suppresses a rule, replacing a suppression it has; answers its entry |
| `DELETE /suppressions/rules/:origin/:slug` | ends a rule's suppression; 204, also when the rule is not suppressed or, with a suppression in force, did not load |
| `PUT /suppressions/inputs/:path` | suppresses an input path, replacing a suppression it has; answers the suppression |
| `DELETE /suppressions/inputs/:path` | ends an input suppression; 204, also when the path is not suppressed |
| `GET /suppressions/inputs/:path/preview` | what suppressing the path would do, without doing it |
| `GET /rulesets` | every loaded ruleset, and the problems of the last discovery |
| `POST /rulesets/rescan` | discovers the rulesets again and applies what changed; answers as `GET /rulesets` |
| `PUT /rulesets/:slug/enabled` | enables or disables a ruleset from `{ "enabled": true \| false }`; answers its entry |
| `PUT /rulesets/:slug/parameters` | replaces a ruleset's parameter values with the body, an object of values by parameter name; answers its entry |
| `DELETE /rulesets/:slug/notices` | dismisses a ruleset's notices; 204 |

`origin` is `user` for rules created through this API. User rules are stored in the plugin's data directory, one file per rule as `rules/<slug>.json`, and validated at start; one that no longer validates does not run and is named in the plugin status. A rule from a ruleset has the ruleset's slug as its `origin`; it is read-only, but takes the same controls, suppressions and resets as a user rule. `:path` is a Signal K path relative to `vessels.self`, such as `propulsion.port.revolutions`.

### Rule entry

```json
{
  "origin": "user",
  "slug": "oil-pressure-low",
  "ruleset": { "name": "Battery monitoring", "version": "1.0.0", "package": { "name": "signalk-alert-ruleset-example", "version": "1.0.0" } },
  "rule": { ... },
  "enabled": true,
  "note": "Sender replaced in spring",
  "suppression": { "since": "2026-09-30T12:00:00.000Z", "actor": "admin", "autoEndAfter": 600 },
  "status": { ... }
}
```

- `ruleset`: for a ruleset rule only, the ruleset's name and version and, for one from a package, the package's name and version.
- `rule`: for a ruleset rule, the rule as the ruleset's parameter values resolve it.
- `enabled`, `note` and `suppression`: the rule's [controls](#rule-controls); `note` and `suppression` are absent when the rule has none. `suppression` is the rule's own; an input suppression shows in `status` only.
- `status`: the rule's status with its badge, sub-labels and per-instance rows, as described in [Status](rules.md#status). A rule that is not evaluated has the `disabled` badge with the reason `disabled`, `ruleset is disabled` or, for every rule while evaluation is off, `evaluation is off`. A ruleset rule whose paths the server has not had has the `inactive` badge with the reason `ruleset path missing` and one issue per missing path; once they have all appeared, until the next evaluation tick starts it, the reason is `starts at the next tick` with no issues. Either way its accumulator totals are instance rows with `progress`.

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
- `changes`: the parts of the rule that make it restart, by field path: `signal`, `gates`, `latching`, `detector.limit.level`, or `detector.<field>`.
- `activeAlerts`: how many of the rule's instances have an active alert now.
- `clearsActiveAlert`: the edit restarts the rule while it has an active alert, so saving it clears that alert; the panel asks for confirmation. It counts only clears the restart causes: an edit applied in place, for example a raised limit, can also clear an active alert at the next evaluation, when the current value no longer meets the condition.
- `discardsTotal`: the rule has an accumulator total above zero, running or kept while it does not run, and saving the edit would discard it: the edit is no longer an accumulator of the same measure. Replacing a stored rule that failed validation keeps its total when both the stored file and the new rule are accumulators of the same measure.

The preview uses the same comparison the engine applies when the edit is saved.

### Rule controls

The rule behaviour behind these routes is in [Enable and suppression](rules.md#enable-and-suppression). Controls and suppressions persist in the data directory and survive restarts.

- Disabling a rule clears its alerts and stops evaluating it; enabling it starts it as a new rule. Setting the current value changes nothing and is not logged.
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

### Evaluation switch

```json
{ "enabled": false, "actor": "admin", "at": "2026-09-30T12:00:00.000Z" }
```

- Turning evaluation off clears every alert SKAR owns: every active alert under `alerts.rules.` whose `$source` is SKAR, and every alert SKAR is heartbeating. Rules stop being evaluated. This is how all of SKAR's alerts are cleared at once; clearing them while rules keep evaluating would only raise them again.
- Turning it on starts every rule from nothing. An active alert SKAR still has in core is cleared rather than adopted, and each rule raises again once its condition holds.
- The switch persists. A plugin started with evaluation off evaluates nothing and clears nothing.
- Accumulator totals are kept while evaluation is off, and rules can still be created, edited, deleted and reset.
- Setting the switch to its current value changes nothing and is not logged.

### Action log

The last 200 actions, newest first, kept in the data directory:

```json
[
  { "at": "2026-09-30T12:02:00.000Z", "actor": "admin", "action": "evaluation", "enabled": false },
  { "at": "2026-09-30T12:01:00.000Z", "actor": "admin", "action": "reset", "rule": "user.engine-hours" },
  { "at": "2026-09-30T12:00:00.000Z", "actor": "admin", "action": "delete", "rule": "user.oil-pressure-low" }
]
```

- `action` is `delete`, `reset`, `enable`, `disable` or `note` with `rule`; `suppress` or `unsuppress` with `rule` or `path`; `evaluation` with `enabled`; `enable`, `disable`, `parameters` or `dismiss` with `ruleset`, the ruleset's slug; or `rescan`.
- `rule` is `<origin>.<slug>`.
- A suppression that ends by itself is logged as `unsuppress` with the actor `auto-end`.

### Plugin state

```json
{
  "running": true,
  "securityEnabled": true,
  "evaluation": { "enabled": true },
  "issues": []
}
```

- `running`: whether the plugin is running. While it is not, every other route answers 503.
- `error`: why the plugin did not start, such as a server without the alerts API, or an evaluation switch, accumulator totals or action log that could not be read from the data directory.
- `securityEnabled`: whether the server enforces security; `null` when SKAR cannot tell.
- `evaluation` and `issues`, while running: the evaluation switch, and the problems found while loading the data directory, such as a stored rule that no longer validates or cannot be read. Such a rule is not listed in `GET /rules`; it can be replaced with `PUT` or deleted.

### Rule links

The configuration panel opens a rule's detail view from a link, such as one an alert carries. The admin UI routes with its own hash, so the rule rides as a second fragment after the panel's route:

```
/admin/#/apps/configuration/signalk-alert-rules#rule=<origin>/<slug>
```

- `origin` and `slug` are each percent-encoded as `encodeURIComponent` does. A slug contains no slash and an origin, a scoped package name, may, so the slug is what follows the last `/`.
- A link to a rule that is not listed, because it was deleted or no longer validates, shows that the rule was not found.

## Errors

Errors answer `{ "error": "<message>" }`. A body that fails validation answers 400 and adds `errors`, a list of `{ "path", "message" }` with a JSON pointer to each offending field.

| Status | When |
|---|---|
| 400 | invalid body; an input path that is not exact; a `PUT` or preview whose `slug` differs from the path's; a reset of a rule that is not an accumulator |
| 404 | no such rule or ruleset |
| 409 | `POST /rules` with a slug a stored rule already has |
| 415 | a mutating request without `Content-Type: application/json` |
| 500 | the data directory could not be written, or evaluation could not be turned on or off because the server's alerts could not be read. A rule, deletion or evaluation switch that could not be saved is not applied. Evaluation that could not be turned on stays off; evaluation that was turned off is off and in the action log, but SKAR's alerts may not have been cleared. A reset, or a save or deletion that discards an accumulator total, whose totals could not be saved has been applied, but the old total returns after a restart unless a later checkpoint succeeds; a reset or deletion is in the action log all the same. An action whose log entry could not be written has been applied. A deletion whose controls could not be removed has deleted the rule, and a rule later created with its slug takes those controls. |
| 503 | the plugin is not running |
