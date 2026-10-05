# signalk-alert-rules

Alert Rules is a Signal K server plugin (npm `signalk-alert-rules`; code and comments call it SKAR) that raises alerts through the core Signal K alerts API from rules over Signal K data.

## Boundaries

- SKAR decides when a condition starts and ends, and which step of its rule it has reached, and emits `alerts.*` deltas. The server's alerts API owns the lifecycle: acknowledgement, silencing, escalation of an unacknowledged alert, persistence. SKAR never acknowledges or silences an alert, and never escalates one on time; a rule's steps raise its priority only as the condition worsens.
- SKAR is a generic Signal K plugin. Code and documentation contain no dependency on or reference to specific hardware or distributions; `signalk-halpi` may appear as an example template set provider.
- Stopping the plugin never clears alerts: stop also runs on every configuration save.

## Commands

`./run help` lists them. `./run ci` runs typecheck, lint, format check, the panel build and tests. The lefthook pre-commit hook (`./run install-hooks`) runs typecheck, lint and format check only. `./run build-panel` bundles the webapp into `public/`; the bundle smoke test `test/panel/bundle-smoke.test.ts` is skipped until the panel has been built. `./run contract-test <server>` runs `test/integration/core-contract.test.ts` against a built Signal K server checkout of the alerts branch; it pins the core alerts behaviour SKAR relies on, takes about three minutes because core's source timeout is a fixed 60 s, and is skipped everywhere else, CI included.

## Conventions

- ESM TypeScript, Node 22, strict type checking, no `any`.
- Tests: Vitest under `test/`, mirroring `src/`. `test/helpers/MockServerAPI.ts` stands in for the server.
- `src/panel/` is the webapp: a browser React component that the admin UI embeds through module federation (an embeddable webapp, exposed as `./AppPanel`), type-checked by `tsconfig.panel.json` rather than the plugin's tsconfig. React comes from the admin UI's globals through `src/panel/host-shim/`, never from a bundled copy. Its tests are under `test/panel/`.
- Template sets: the built-in set is `templates/builtin.yaml`, shipped in the package. [`docs/templates.md`](docs/templates.md) is the contract for third-party template set packages; `examples/template-set-example` is one, and `test/examples.test.ts` discovers it and makes a rule from each of its templates.
- `docs/examples.md` walks each `examples/rules/*.json` through the editor with screenshots in `docs/images/examples/`. A change to an editor label, kind or the rule detail that the page shows updates the page and re-captures only the affected images, under the same conditions: the render harness (see Rendering the UI) with `?states=docs&history=none`, a 1280 px wide viewport, cropped to the webapp, each editor filled as the page walks it. `?states=docs` gives the rules the states the page shows, with the values of the harness's paths. The harness stands in for a Signal K server on the alerts branch with security off, Kip disabled, the default nautical-metric unit preset and `displayUnits` of `electrical.ac.shore.phase.single.frequency` set to the base unit: its path fixtures carry those display units, its background, text size and sidebar column match the admin UI, and its source is named `example`. A state an image needs that no harness scenario gives is added to the harness as a scenario, never as an uncommitted edit.
- Versioning: `./run bumpversion patch|minor|major` updates `VERSION` and `package.json`. Publishing to npm happens from a GitHub release whose tag matches `VERSION`, through npm trusted publishing. The very first version must be published manually, because npm can only attach a trusted publisher to a package that already exists.
- Comments explain why the code is the way it is, never what changed.

## Rendering the UI

`harness/` serves the webapp on a fake server: `harness/main.tsx` puts React on the admin UI's globals, as the admin UI does, and mounts `Shell` with a fake `PanelApi`, path source and history source (`harness/fakeServer.ts`). The rules are `examples/rules/*.json`, the paths `test/panel/reportedPaths.ts`, the template sets `templates/builtin.yaml` and `examples/template-set-example`. Writes change the rules in memory until the page reloads. The harness is not in the package (`files`) or the panel bundle, and Bootstrap's stylesheet comes from a CDN.

```
npm ci
./run harness 5173
```

Open `http://localhost:5173/`. The page matches the admin UI's body text and page grey, mounts the panel in a box like the one the admin UI embeds a webapp in (one viewport less 105 px tall, painted aliceblue; the panel covers it with the page grey) and, from 992 px wide, leaves the 200 px column of its sidebar, so widths are those of the admin UI with its sidebar open. Query parameters pick the fake server's answers, and the hash picks the view as in the admin UI (`src/panel/route.ts`), so `http://localhost:5173/?history=error#rule=house-battery-low` is the rule detail with the history failing. `OPTIONS` in `harness/scenario.ts` lists each parameter's values and what they answer, the first value being the default; an unknown value logs a console warning and falls back to it. `test/panel/harness.test.ts` passes every value's answers through the panel's parsers.

States per view:

- Rules list, at `/`: populated by default; `?rules=empty`, `?plugin=loading`, `?plugin=failed`, `?plugin=notRunning`, `?plugin=unreachable`, `?plugin=session`; partial `?rules=partial`; `?access=readonly`, `?security=off`, `?templates=new`. Over the rules already read, at the poll after the switch: `?after=unreachable` (reconnecting banner), `?after=notRunning` (not running, retrying), `?after=session` (login expired, with Check again).
- Rule detail: `#rule=house-battery-low` (alerting, zone limit), `#rule=coolant-temperature-rising` (wildcard instances), `#rule=engine-service-due` (total), `#rule=bilge-pump-cycling` (event count), `#rule=watch-not-acknowledged` (disabled), `#rule=depth-sensor-silent` (no data), `#rule=shore-power-frequency` (alerting above the range), `?rules=partial#rule=coolant-high` (invalid), `#rule=no-such-rule` (not found); loading and error states are the list's `plugin` values. `?controls=refused` and Disable, Enable, Reset or Delete shows the notice of a write refused for the login's level.
- History chart, on any rule detail or editor: `?history=data|gaps|empty|loading|error|none`.
- Editor, new rule: `#add=path` (path search; `?paths=loading|error|empty`), `#add=path&path=electrical.batteries.start.voltage` (kind picker), `#add=path&path=electrical.batteries.start.voltage&when=below` (form). Choosing a priority and limit and pressing Create rule shows success (the new rule's detail), `?save=rejected`, `?save=error` or `?save=refused` (the level refusal notice). The fake refuses what the server would: the same form for `electrical.batteries.house.voltage` makes an alert path overlapping `house-battery-low`'s, and naming the rule `House battery low` takes that rule's slug.
- Editor, existing rule: `#edit=house-battery-low`; `?definition=loading`, `?definition=error`; `?preview=restart` and Save shows the confirmation; `?access=readonly` shows the refusal; `?save=refused` and Save shows the level refusal notice.
- Editor, invalid stored rule: `?rules=partial#edit=coolant-high`; saving it starts the rule fresh, as creating it would. `?rules=fixedLimit#edit=house-battery-fixed-limit` (a fixed detector limit, its errors on the zones checkbox) is a stored rule the editor cannot make. So are `?rules=angularRatio#edit=engine-rpm-ratio-angular` (a ratio flagged as angles), `?rules=eventValue#edit=bilge-pump-changes-value` (a count whose "changes" event carries a value) and `?rules=zoneSteps#edit=house-battery-zone-steps` (a zone-limit rule with steps), each with its error listed above Save.
- Add rule and templates: `#add` (`?templates=loading|error|none`), `#add=template&set=builtin`, `#add=template&set=builtin&template=battery-voltage-low` (picker), `#add=template&set=builtin&template=battery-voltage-low&picks=%5B%7B%22instance%22%3A%22house%22%7D%5D&step=edit` (the rules the picks make).

Reloading with a dirty form raises a beforeunload dialog that browser automation must accept.

Server-backed checks (path search, units and zones from a real server) need a Signal K server from the alerts branch with Alert Rules installed into a scratch config directory: `npm run build`, then `npm install <this repo>` in the config directory, enable the plugin in `plugin-config-data/signalk-alert-rules.json`, disable Kip there as well (its history provider records nothing and leaves an empty chart beside every form), feed sample data through an `n2kFromFile` piped provider, and start the server with `PORT=3456 node bin/signalk-server -c <config dir>`. The webapp is then at `http://localhost:3456/admin/#/e/signalk_alert_rules`; paths the sample data lacks, zones, sources and `displayUnits` come from a delta feeder over `ws://localhost:3456/signalk/v1/stream`.

## Plan

The implementation plan is tracked in issue 1 of this repository, with one sub-issue per unit. The plan for Disable, template sets and the webapp is issue 54, also with one sub-issue per unit.
