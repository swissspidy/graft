---
'@swissspidy/graft-core': minor
'@swissspidy/graft-a2ui': minor
---

Fixes from a full read of the code.

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
