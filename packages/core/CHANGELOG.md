# @swissspidy/graft-core

## 0.2.0

### Minor Changes

- [#49](https://github.com/swissspidy/graft/pull/49) [`68ff72d`](https://github.com/swissspidy/graft/commit/68ff72d229176cab85e3b9ac6a47b208546b90ab) Thanks [@swissspidy](https://github.com/swissspidy)! - The cfworker schema engine (`@swissspidy/graft-core/cfworker`) now words `required` and `pattern` errors as Ajv does, with the missing property's name and the pattern in `message` (`must have required property 'due'`, `must match pattern "^[a-z]+$"`). Hosts that show `error.message` directly read the same on either engine.

- [#52](https://github.com/swissspidy/graft/pull/52) [`e5d8fb3`](https://github.com/swissspidy/graft/commit/e5d8fb3e3b0e9e082ff293dfdb503f582bd4c73f) Thanks [@swissspidy](https://github.com/swissspidy)! - Triggers (ADR 0010): builds can act without a viewer, on a schedule or a host event. Specs declare `triggers` with their own permissions and per-run limit; surfaces declare what triggers may use (`triggers`: events, capabilities, bounds); builds carry `triggers` (targets, `where`, one call per target, `once`) and `refs.triggers`. New: the `$target` expression, `runTrigger()`, `triggerCallRefusal()`, `triggerScopes()`, `describeWhen()`, validation of triggers in specs and builds, the check step `{ "trigger": id }` and the `run` expectation (run by `Sandbox.fire`), `triggerGrant` in `verifyBuild()` and `upgradeBuild()`, the `event` migration kind, and triggers in the compiler's UI phase (`triggers_json`).

- [#48](https://github.com/swissspidy/graft/pull/48) [`967f872`](https://github.com/swissspidy/graft/commit/967f8725bdc702f54699a7805988c1b9bd5c5c0b) Thanks [@swissspidy](https://github.com/swissspidy)! - Dragging in the Graft catalog: a Card with `draggable` can be dropped on a Column, Row or Card with a `dropTarget`, which presses the Card's Button with that `dropTarget`. The verifier reads a template of Cards as a list of rows and records which drop target each list is in. Checks can drag (`{"drop": {...}, "on": "<target>"}`), read the rows in one place (`{"rows": [...], "in": "<target>"}`), call an action the viewer is not offered (`"direct": true`), and expect the host to refuse it (`{"refused": "<action id>"}`).

- [#54](https://github.com/swissspidy/graft/pull/54) [`d8cef9e`](https://github.com/swissspidy/graft/commit/d8cef9eb2c0305fa0d62c659020f86b12b047ad8) Thanks [@swissspidy](https://github.com/swissspidy)! - graft-a2ui moves to `@a2ui/web_core` 0.14, the version `@swissspidy/a2ui-wp` 0.2 renders with; apps that pass graft-a2ui catalogs to a renderer need the same web_core. web_core 0.14 refuses to run regex patterns that can backtrack catastrophically (ReDoS), so validation now reports them as `a2ui-unsafe-pattern` instead of a build that silently stops working, and the compiler guide tells models to anchor patterns.

### Patch Changes

- [#53](https://github.com/swissspidy/graft/pull/53) [`4a0e20f`](https://github.com/swissspidy/graft/commit/4a0e20f4b40b73bc0611009bcde83d0373e0eac6) Thanks [@swissspidy](https://github.com/swissspidy)! - Dependency updates: ajv 8.20 and yaml 2.9.

## 0.1.1

### Patch Changes

- [#40](https://github.com/swissspidy/graft/pull/40) [`e2cb8ce`](https://github.com/swissspidy/graft/commit/e2cb8ce7c5b9607d938a3fc41abf36dd19c791c9) Thanks [@swissspidy](https://github.com/swissspidy)! - First release through changesets and npm staged publishing, with provenance from trusted publishing. No code changes since 0.1.0.
