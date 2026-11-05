# @swissspidy/graft-a2ui

## 0.2.0

### Minor Changes

- [#48](https://github.com/swissspidy/graft/pull/48) [`967f872`](https://github.com/swissspidy/graft/commit/967f8725bdc702f54699a7805988c1b9bd5c5c0b) Thanks [@swissspidy](https://github.com/swissspidy)! - Dragging in the Graft catalog: a Card with `draggable` can be dropped on a Column, Row or Card with a `dropTarget`, which presses the Card's Button with that `dropTarget`. The verifier reads a template of Cards as a list of rows and records which drop target each list is in. Checks can drag (`{"drop": {...}, "on": "<target>"}`), read the rows in one place (`{"rows": [...], "in": "<target>"}`), call an action the viewer is not offered (`"direct": true`), and expect the host to refuse it (`{"refused": "<action id>"}`).

- [#57](https://github.com/swissspidy/graft/pull/57) [`ec6063b`](https://github.com/swissspidy/graft/commit/ec6063b74455d03aeca8195fbb2d4b5431e96457) Thanks [@swissspidy](https://github.com/swissspidy)! - Diagnostics point at the spec. A build's diagnostics about where it disagrees with its spec (mount slot, a scope the spec does not request, a criterion without a check, a trigger the spec declares or does not, a trigger's schedule, event or permissions) carry `spec: { path, line }`, the frontmatter key and the spec line to fix. `Spec.lines` maps each frontmatter key to its line, and `specKey()` and `specCriterion()` look up locations. Frontmatter diagnostics now name the line of the key rather than of its value (a field missing from `mount` is on the `mount:` line), and `title-missing` and `description-missing` carry lines. `build-spec-mismatch` for the spec id and the spec hash is reported separately, at `/spec/id` and `/spec/hash`.

- [#59](https://github.com/swissspidy/graft/pull/59) [`dc27456`](https://github.com/swissspidy/graft/commit/dc27456ecbdbfdd2d1a249e46e11903f784240d4) Thanks [@swissspidy](https://github.com/swissspidy)! - Verification records name the build they verified. `verifyBuild()` now sets `build` on the `Verification` to the build's content hash (`buildHash()`, now also exported from its own module), and the new `verificationProblem(verification, build)` says why a record does not show that this exact build passed: it names another build (the build changed after it was verified, even in a way that keeps it valid), none at all (a record from before this change), another spec version or surface, or does not have one passing result for each check. `graft check`, the browser extension's bundle install and serving, and the EmDash store use it, so a build edited after verification no longer counts as verified there. Records without `build` count as unverified: bundle and verify again.

- [#54](https://github.com/swissspidy/graft/pull/54) [`d8cef9e`](https://github.com/swissspidy/graft/commit/d8cef9eb2c0305fa0d62c659020f86b12b047ad8) Thanks [@swissspidy](https://github.com/swissspidy)! - graft-a2ui moves to `@a2ui/web_core` 0.14, the version `@swissspidy/a2ui-wp` 0.2 renders with; apps that pass graft-a2ui catalogs to a renderer need the same web_core. web_core 0.14 refuses to run regex patterns that can backtrack catastrophically (ReDoS), so validation now reports them as `a2ui-unsafe-pattern` instead of a build that silently stops working, and the compiler guide tells models to anchor patterns.

### Patch Changes

- [#53](https://github.com/swissspidy/graft/pull/53) [`4a0e20f`](https://github.com/swissspidy/graft/commit/4a0e20f4b40b73bc0611009bcde83d0373e0eac6) Thanks [@swissspidy](https://github.com/swissspidy)! - Dependency updates: ajv 8.20 and yaml 2.9.
- Updated dependencies [[`68ff72d`](https://github.com/swissspidy/graft/commit/68ff72d229176cab85e3b9ac6a47b208546b90ab), [`4a0e20f`](https://github.com/swissspidy/graft/commit/4a0e20f4b40b73bc0611009bcde83d0373e0eac6), [`e5d8fb3`](https://github.com/swissspidy/graft/commit/e5d8fb3e3b0e9e082ff293dfdb503f582bd4c73f), [`967f872`](https://github.com/swissspidy/graft/commit/967f8725bdc702f54699a7805988c1b9bd5c5c0b), [`ec6063b`](https://github.com/swissspidy/graft/commit/ec6063b74455d03aeca8195fbb2d4b5431e96457), [`dc27456`](https://github.com/swissspidy/graft/commit/dc27456ecbdbfdd2d1a249e46e11903f784240d4), [`d8cef9e`](https://github.com/swissspidy/graft/commit/d8cef9eb2c0305fa0d62c659020f86b12b047ad8)]:
  - @swissspidy/graft-core@0.2.0

## 0.1.1

### Patch Changes

- [#40](https://github.com/swissspidy/graft/pull/40) [`e2cb8ce`](https://github.com/swissspidy/graft/commit/e2cb8ce7c5b9607d938a3fc41abf36dd19c791c9) Thanks [@swissspidy](https://github.com/swissspidy)! - First release through changesets and npm staged publishing, with provenance from trusted publishing. No code changes since 0.1.0.
- Updated dependencies [[`e2cb8ce`](https://github.com/swissspidy/graft/commit/e2cb8ce7c5b9607d938a3fc41abf36dd19c791c9)]:
  - @swissspidy/graft-core@0.1.1
