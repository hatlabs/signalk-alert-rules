# signalk-alert-rules

A Signal K server plugin that raises alerts through the Signal K alerts API from rules over Signal K data. A rule watches one or more paths, detects a condition (a value past a limit for a duration, a trend, a count per window, an absence of events, and so on), can be gated on other paths, and raises an alert at a chosen priority while the condition holds.

The plugin raises alerts; the server's alerts API owns their lifecycle (acknowledgement, silencing, escalation, persistence), and an alert console displays them.

Rules, rulesets and suppressions are managed in the Alert Rules webapp, under Webapps in the admin UI. The admin UI lists it only while the plugin is enabled; the plugin's configuration page holds just the Enabled switch.

[`docs/rules.md`](docs/rules.md) describes the rule model: signals, detectors, gates, limits, and the alerts a rule sends. [`examples/rules`](examples/rules) holds worked example rules covering all seven detectors, gates, a zone limit, latching, and the `absDifference` (plain and angular) and `positionSpread` combinators. [`docs/api.md`](docs/api.md) describes the admin-only REST API that manages rules, reports their status and resets accumulators.

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
