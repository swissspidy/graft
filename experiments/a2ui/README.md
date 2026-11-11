# A2UI experiment: history and evidence

This directory started as a proof of concept: can a Graft build carry its
UI as an [A2UI](https://a2ui.org/) surface? It has since become part of
Graft, and the decision is [ADR 0009](../../docs/adr/0009-a2ui.md). What
used to live here now lives in:

| | |
| --- | --- |
| The format, catalog, verifier side | [`packages/a2ui`](../../packages/a2ui) (`@swissspidy/graft-a2ui`, on `@a2ui/web_core`) |
| Core hooks | `packages/core/src/build/format.ts` |
| WordPress | `hosts/wordpress/adapter/src/a2ui.ts`, `src/client/a2ui.tsx` (@swissspidy/a2ui-wp), `e2e/a2ui.spec.ts` |
| EmDash | `hosts/emdash/adapter/src/host/a2ui.ts`, `src/node/a2ui-smoke.ts` |
| Example builds | `examples/builds` (WordPress), `examples/emdash/builds` |
| Compiling | `graft compile --ui a2ui` |

What stays here is evidence:

- [`compiled/`](compiled/): the first compiles of the WordPress example
  specs against their frozen checks, with every attempt's output, and
  [`fresh/`](compiled/fresh/), the checks phase written for A2UI.
  [`promote.ts`](promote.ts) turned them into the example builds (then
  in `examples/a2ui/builds`, now `examples/builds`).
- [`emdash/`](emdash/): the EmDash examples compiled with `graft compile
  --ui a2ui`. `status-board.first-run.*` failed three attempts because of
  a verifier bug, since fixed: a local `set` wrote into the build's own
  `initial` object, so its state leaked into later checks. Claude spent
  the attempts chasing it.
- [`specs/submit-for-review.md`](specs/submit-for-review.md) and
  [`wizard/`](wizard/): a two-step flow, compiled end to end (checks phase
  included). The first run hit a catalog gap (row actions could not be
  local actions). The second (`second-run.json`) passed all nine checks,
  with a bug the checks cannot see: `initial` picks post 41. The validator
  now refuses that (`a2ui-initial-row-value`); the third run, reusing the
  checks, passed on its first attempt and starts with nothing chosen.

## What the runs showed, in order

1. **Verifying.** review-queue's frozen checks pass for an A2UI version of
   the build. The two broken variants fail exactly the check that covers
   each mistake.
2. **Compiling.** All seven WordPress example specs compile to A2UI with
   no code: review-queue in two attempts, the others in one. Widgets and
   `$fn` became catalog functions, `computed` lists and local `set`
   actions. Each addition to the catalog came from a spec that needed it.
3. **Checks.** Fresh checks written for A2UI found two flaws in Graft's
   check vocabulary that apply to trees as well: button labels and table
   cells did not count as shown text. Claude added a line the spec never
   asked for, just to show "47" outside a table. Fixed on `main`, with
   input labels added in this branch.
4. **Upgrades.** The canary scenarios reach the same outcomes as tree
   builds. The exception is a host that stops running code, which A2UI
   builds survive.
5. **First-class.** The builds are stored, approved, served and drawn
   through Graft's own paths on WordPress and EmDash.
