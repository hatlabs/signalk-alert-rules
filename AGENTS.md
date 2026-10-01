# signalk-alert-rules

Signal K server plugin (npm `signalk-alert-rules`, short name SKAR) that raises alerts through the core Signal K alerts API from rules over Signal K data.

## Boundaries

- SKAR decides when a condition starts and ends and emits `alerts.*` deltas. The server's alerts API owns the lifecycle: acknowledgement, silencing, escalation, persistence. SKAR never acknowledges, silences or escalates.
- SKAR is a generic Signal K plugin. Code and documentation contain no dependency on or reference to specific hardware or distributions; `signalk-halpi` may appear as an example ruleset provider.
- Stopping the plugin never clears alerts: stop also runs on every configuration save.

## Commands

`./run help` lists them. `./run ci` runs typecheck, lint, format check, the panel build and tests. The lefthook pre-commit hook (`./run install-hooks`) runs typecheck, lint and format check only. `./run build-panel` bundles the webapp into `public/`; the bundle smoke test `test/panel/bundle-smoke.test.ts` is skipped until the panel has been built. `./run contract-test <server>` runs `test/integration/core-contract.test.ts` against a built Signal K server checkout of the alerts branch; it pins the core alerts behaviour SKAR relies on, takes about three minutes because core's source timeout is a fixed 60 s, and is skipped everywhere else, CI included.

## Conventions

- ESM TypeScript, Node 22, strict type checking, no `any`.
- Tests: Vitest under `test/`, mirroring `src/`. `test/helpers/MockServerAPI.ts` stands in for the server.
- `src/panel/` is the webapp: a browser React component that the admin UI embeds through module federation (an embeddable webapp, exposed as `./AppPanel`), type-checked by `tsconfig.panel.json` rather than the plugin's tsconfig. React comes from the admin UI's globals through `src/panel/host-shim/`, never from a bundled copy. Its tests are under `test/panel/`.
- Versioning: `./run bumpversion patch|minor|major` updates `VERSION` and `package.json`. Publishing to npm happens from a GitHub release whose tag matches `VERSION`, through npm trusted publishing. The very first version must be published manually, because npm can only attach a trusted publisher to a package that already exists.
- Comments explain why the code is the way it is, never what changed.

## Plan

The implementation plan is tracked in issue 1 of this repository, with one sub-issue per unit.
