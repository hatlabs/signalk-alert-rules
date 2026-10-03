# signalk-alert-rules

Alert Rules is a Signal K server plugin that raises alerts through the Signal K alerts API from rules over Signal K data. A rule watches one or more paths, detects a condition (a value past a limit for a duration, a trend, a count per window, an absence of events, and so on), can be gated on other paths, and raises an alert while the condition holds, climbing in priority through up to four steps as the condition worsens.

The plugin raises alerts; the server's alerts API owns their lifecycle (acknowledgement, silencing, escalation of an unacknowledged alert, persistence), and an alert console displays them.

Rules are managed in the Alert Rules webapp, under Webapps in the admin UI. The admin UI lists it only while the plugin is enabled; the plugin's configuration page holds just the Enabled switch. In the webapp:

- The rule list shows every rule, those that need attention first, with its condition: alerting, normal, no data or problem, or disabled.
- A rule's detail view explains its condition and shows each instance. A rule can be disabled there, with a note saying why: it keeps evaluating but raises nothing until someone enables it again.
- Add rule starts a rule from a template or from a path. A template leaves the instance, such as which battery bank, or the source open, and the user picks it.
- For a rule on one concrete path, the editor shows the path's live value and, where it can compare that value with the limits, whether the rule would alert at it; and, while the server has a history provider, a chart of its recorded values with the rule's limits.

Read-only users view the rules, read/write users also disable and enable them, and administrators do everything else.

[`docs/rules.md`](docs/rules.md) describes the rule model: signals, detectors, steps, gates, limits, alert paths, Disable, and the alerts a rule sends. [`examples/rules`](examples/rules) holds worked example rules covering all seven detectors, gates, a zone limit, latching, and the `absDifference` (plain and angular) and `positionSpread` combinators. [`docs/templates.md`](docs/templates.md) describes template sets: the one built in, and those another package provides, as [`examples/template-set-example`](examples/template-set-example) does. [`docs/api.md`](docs/api.md) describes the REST API that manages rules, reports their status, disables and enables them and lists templates; it is open by role, with the access level of each route given there.

## Requirements

- A Signal K server with the core alerts API. On a server without it the plugin reports an error and evaluates nothing.
- Node.js 22 or later.

## Behaviour to know

- Stopping or restarting the plugin does not clear the alerts it raised. They go stale while it is stopped, and the next start adopts them, so each rule keeps or clears its alert.
- With server security disabled, anyone who can reach the server can change the rules.
- A latching rule raises its alert once each time its condition becomes active, and the alert waits for acknowledgment; nothing is sent while the condition lasts or when it ends. Only detectors whose condition is an event can latch: a count, or a match with `changesTo` or `decreases`. A lasting condition does not need latching to be acknowledged: at a priority that requires acknowledgment, its alert already waits for it after the condition returns to normal.

## Development

```bash
npm install
./run install-hooks
./run ci
```

`./run help` lists all commands. `./run deploy <host|local> <signalk-config-dir>` builds the plugin and copies it into a Signal K server's `node_modules`.

## License

Apache-2.0
