# REST API

SKAR serves its rules, their status and its operator actions under the plugin's route on the Signal K server, `/plugins/signalk-alert-rules`. The configuration panel is its client. Bodies are JSON; values are in SI units, as in [the rule model](rules.md).

## Security

- Every route is admin-only while server security is enabled: the server checks admin access for every plugin route a plugin does not open up to other access levels, and SKAR opens none.
- With security disabled, anyone who can reach the server can use every route. `GET /state` reports `securityEnabled: false` so the panel can show a persistent warning.
- Every `POST`, `PUT` and `DELETE` must carry `Content-Type: application/json`, including those without a body; anything else is refused with 415. A browser does not send that content type to another site without asking the site first, so a page elsewhere cannot act through an admin's session.
- Deletes, accumulator resets and evaluation switches record the actor: the authenticated user's id, or `unauthenticated` when there is none.

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

`origin` is `user` for rules created through this API. Rules from rulesets and the routes that manage rulesets are not implemented yet.

### Rule entry

```json
{ "origin": "user", "slug": "oil-pressure-low", "rule": { ... }, "status": { ... } }
```

`status` is the rule's status with its badge, sub-labels and per-instance rows, as described in [Status](rules.md#status). It is `null` while evaluation is off.

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

`rule` is `<origin>.<slug>`.

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

## Errors

Errors answer `{ "error": "<message>" }`. A body that fails validation answers 400 and adds `errors`, a list of `{ "path", "message" }` with a JSON pointer to each offending field.

| Status | When |
|---|---|
| 400 | invalid body; a `PUT` or preview whose `slug` differs from the path's; a reset of a rule that is not an accumulator |
| 404 | no such rule |
| 409 | `POST /rules` with a slug a stored rule already has |
| 415 | a mutating request without `Content-Type: application/json` |
| 500 | the data directory could not be written, or evaluation could not be turned on because the server's alerts could not be read. A rule, deletion or evaluation switch that could not be saved is not applied, and evaluation that could not be turned on stays off. A reset, or a save or deletion that discards an accumulator total, whose totals could not be saved has been applied, but the old total returns after a restart unless a later checkpoint succeeds; a reset or deletion is in the action log all the same. An action whose log entry could not be written has been applied. |
| 503 | the plugin is not running |
