# signalk-alert-rules

Signal K server plugin (npm `signalk-alert-rules`, short name SKAR) that raises alerts through the core Signal K alerts API from rules over Signal K data.

## Boundaries

- SKAR decides when a condition starts and ends and emits `alerts.*` deltas. The server's alerts API owns the lifecycle: acknowledgement, silencing, escalation, persistence. SKAR never acknowledges, silences or escalates.
- SKAR is a generic Signal K plugin. Code and documentation contain no dependency on or reference to specific hardware or distributions; `signalk-halpi` may appear as an example ruleset provider.
- Stopping the plugin never clears alerts: stop also runs on every configuration save.

## Commands

`./run help` lists them. `./run ci` runs typecheck, lint, format check and tests; the lefthook pre-commit hook runs the same checks (`./run install-hooks`).

## Conventions

- ESM TypeScript, Node 22, strict type checking, no `any`.
- Tests: Vitest under `test/`, mirroring `src/`. `test/helpers/MockServerAPI.ts` stands in for the server.
- Versioning: `./run bumpversion patch|minor|major` updates `VERSION` and `package.json`. Publishing to npm happens from a GitHub release whose tag matches `VERSION`, through npm trusted publishing. The very first version must be published manually, because npm can only attach a trusted publisher to a package that already exists.
- Comments explain why the code is the way it is, never what changed.

## Plan

The implementation plan is tracked in issue 1 of this repository, with one sub-issue per unit.
