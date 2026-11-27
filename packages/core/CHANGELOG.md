# @swissspidy/graft-core

## 0.2.0

### Minor Changes

- [#65](https://github.com/swissspidy/graft/pull/65) [`ae1ed17`](https://github.com/swissspidy/graft/commit/ae1ed1790ec1a2639e2ef7fee31e93e42113bccd) Thanks [@swissspidy](https://github.com/swissspidy)! - Fixes from a full read of the code.
  
  `@swissspidy/graft-a2ui`:
  
  - What a viewer entered or set can no longer replace what the host loaded. `walkA2UI` refuses entered values under a data source or `/slot`, and validation refuses an input or a `set` that writes there (`a2ui-input-binding`, `a2ui-model-key`). Hosts that keep local state in the page (EmDash, the browser extension) trusted it to overwrite loaded rows before resolving an action.
  - `replace` is held to the same pattern rules as `regex`: an unsafe pattern is `a2ui-unsafe-pattern`, one that does not compile or is read from data is `a2ui-function-args`, and at run time such a pattern leaves the text unchanged instead of stalling or throwing. `TextField.validationRegexp` is checked too.
  - `can`'s scope must be written out (`a2ui-function-args`), and `can`, `regex`, `replace` and `set` cannot be called inside a `formatString` template (`a2ui-template-call`), where validation could not see them. `/slot/...` pointers inside templates now count as slot props the build reads.
  - The same holds however the pointer is spelled (`//slot`, the root `/`) and for a data source whose call failed. `refresh:` and `remove-row:` entries with extra `:` parts are refused, as `reload:` ones were.
  - Event, capability and scope names that every object has (`toString`, `constructor`) are no longer taken as bound or known.
  - New diagnostics: `a2ui-duplicate-label` (two table columns with one label) and `a2ui-duplicate-reference` (a child listed twice). `then` entries with extra `:` parts are refused.
  - `localState(build, state)` cuts state a host kept outside itself (in the page, in a button's value) down to the pointers the build's own `set` actions target.
  - `validateA2UI` no longer takes a `spec` argument (it never read it), and the unused `dynamicNumber` export is gone.
  
  `@swissspidy/graft-core`:
  
  - The build schema no longer validates nested expressions twice per level: a deeply nested `$not`/`$and` took exponential time on Ajv and overflowed the stack on the cfworker engine.
  - A check whose expectation is malformed (`{"rows": 1}`) or names two things (`{"text": ..., "rows": ...}`) fails with a reason. Before, the first threw and ended the whole verification, and the second passed on its first key alone. `expectationProblem` is exported.
  - A `drop` step presses the button found for that drop target, not the first button with the same action id.
  - `compileSpec` hashes a surface that has no stored hash instead of comparing builds with an empty one.
  - Slot, event and scope names every object has (`constructor`) are unknown, as they should be.
  - A build's refs are compared regardless of key order.
  - Spec parsing: a heading with a long run of spaces no longer backtracks, and a criterion's `{#id}` is read when the criterion continues on the next line.
  - The canary report says which trigger scopes a customization needs (`extraTriggerScopes`), and a check's description mentions `matched`.

- [#49](https://github.com/swissspidy/graft/pull/49) [`68ff72d`](https://github.com/swissspidy/graft/commit/68ff72d229176cab85e3b9ac6a47b208546b90ab) Thanks [@swissspidy](https://github.com/swissspidy)! - The cfworker schema engine (`@swissspidy/graft-core/cfworker`) now words `required` and `pattern` errors as Ajv does, with the missing property's name and the pattern in `message` (`must have required property 'due'`, `must match pattern "^[a-z]+$"`). Hosts that show `error.message` directly read the same on either engine.

- [#52](https://github.com/swissspidy/graft/pull/52) [`e5d8fb3`](https://github.com/swissspidy/graft/commit/e5d8fb3e3b0e9e082ff293dfdb503f582bd4c73f) Thanks [@swissspidy](https://github.com/swissspidy)! - Triggers (ADR 0010): builds can act without a viewer, on a schedule or a host event. Specs declare `triggers` with their own permissions and per-run limit; surfaces declare what triggers may use (`triggers`: events, capabilities, bounds); builds carry `triggers` (targets, `where`, one call per target, `once`) and `refs.triggers`. New: the `$target` expression, `runTrigger()`, `triggerCallRefusal()`, `triggerScopes()`, `describeWhen()`, validation of triggers in specs and builds, the check step `{ "trigger": id }` and the `run` expectation (run by `Sandbox.fire`), `triggerGrant` in `verifyBuild()` and `upgradeBuild()`, the `event` migration kind, and triggers in the compiler's UI phase (`triggers_json`).

- [#48](https://github.com/swissspidy/graft/pull/48) [`967f872`](https://github.com/swissspidy/graft/commit/967f8725bdc702f54699a7805988c1b9bd5c5c0b) Thanks [@swissspidy](https://github.com/swissspidy)! - Dragging in the Graft catalog: a Card with `draggable` can be dropped on a Column, Row or Card with a `dropTarget`, which presses the Card's Button with that `dropTarget`. The verifier reads a template of Cards as a list of rows and records which drop target each list is in. Checks can drag (`{"drop": {...}, "on": "<target>"}`), read the rows in one place (`{"rows": [...], "in": "<target>"}`), call an action the viewer is not offered (`"direct": true`), and expect the host to refuse it (`{"refused": "<action id>"}`).

- [#57](https://github.com/swissspidy/graft/pull/57) [`ec6063b`](https://github.com/swissspidy/graft/commit/ec6063b74455d03aeca8195fbb2d4b5431e96457) Thanks [@swissspidy](https://github.com/swissspidy)! - Diagnostics point at the spec. A build's diagnostics about where it disagrees with its spec (mount slot, a scope the spec does not request, a criterion without a check, a trigger the spec declares or does not, a trigger's schedule, event or permissions) carry `spec: { path, line }`, the frontmatter key and the spec line to fix. `Spec.lines` maps each frontmatter key to its line, and `specKey()` and `specCriterion()` look up locations. Frontmatter diagnostics now name the line of the key rather than of its value (a field missing from `mount` is on the `mount:` line), and `title-missing` and `description-missing` carry lines. `build-spec-mismatch` for the spec id and the spec hash is reported separately, at `/spec/id` and `/spec/hash`.

- [#59](https://github.com/swissspidy/graft/pull/59) [`dc27456`](https://github.com/swissspidy/graft/commit/dc27456ecbdbfdd2d1a249e46e11903f784240d4) Thanks [@swissspidy](https://github.com/swissspidy)! - Verification records name the build they verified. `verifyBuild()` now sets `build` on the `Verification` to the build's content hash (`buildHash()`, now also exported from its own module), and the new `verificationProblem(verification, build)` says why a record does not show that this exact build passed: it names another build (the build changed after it was verified, even in a way that keeps it valid), none at all (a record from before this change), another spec version or surface, or does not have one passing result for each check. `graft check`, the browser extension's bundle install and serving, and the EmDash store use it, so a build edited after verification no longer counts as verified there. Records without `build` count as unverified: bundle and verify again.

- [#54](https://github.com/swissspidy/graft/pull/54) [`d8cef9e`](https://github.com/swissspidy/graft/commit/d8cef9eb2c0305fa0d62c659020f86b12b047ad8) Thanks [@swissspidy](https://github.com/swissspidy)! - graft-a2ui moves to `@a2ui/web_core` 0.14, the version `@swissspidy/a2ui-wp` 0.2 renders with; apps that pass graft-a2ui catalogs to a renderer need the same web_core. web_core 0.14 refuses to run regex patterns that can backtrack catastrophically (ReDoS), so validation now reports them as `a2ui-unsafe-pattern` instead of a build that silently stops working, and the compiler guide tells models to anchor patterns.

### Patch Changes

- [#53](https://github.com/swissspidy/graft/pull/53) [`4a0e20f`](https://github.com/swissspidy/graft/commit/4a0e20f4b40b73bc0611009bcde83d0373e0eac6) Thanks [@swissspidy](https://github.com/swissspidy)! - Dependency updates: ajv 8.20 and yaml 2.9.

## 0.1.1

### Patch Changes

- [#40](https://github.com/swissspidy/graft/pull/40) [`e2cb8ce`](https://github.com/swissspidy/graft/commit/e2cb8ce7c5b9607d938a3fc41abf36dd19c791c9) Thanks [@swissspidy](https://github.com/swissspidy)! - First release through changesets and npm staged publishing, with provenance from trusted publishing. No code changes since 0.1.0.
