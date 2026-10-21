---
"@swissspidy/graft-core": minor
---

Triggers (ADR 0010): builds can act without a viewer, on a schedule or a host event. Specs declare `triggers` with their own permissions and per-run limit; surfaces declare what triggers may use (`triggers`: events, capabilities, bounds); builds carry `triggers` (targets, `where`, one call per target, `once`) and `refs.triggers`. New: the `$target` expression, `runTrigger()`, `triggerCallRefusal()`, `triggerScopes()`, `describeWhen()`, validation of triggers in specs and builds, the check step `{ "trigger": id }` and the `run` expectation (run by `Sandbox.fire`), `triggerGrant` in `verifyBuild()` and `upgradeBuild()`, the `event` migration kind, and triggers in the compiler's UI phase (`triggers_json`).
