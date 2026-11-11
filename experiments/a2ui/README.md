# A2UI experiment: history and evidence

This directory started as a proof of concept: can a Graft build carry its
UI as an [A2UI](https://a2ui.org/) surface? It has since become part of
Graft, and the decision is [ADR 0009](../../docs/adr/0009-a2ui.md). What
used to live here now lives in:

| | |
| --- | --- |
| The format, catalog, verifier side | [`packages/a2ui`](../../packages/a2ui) (`@swissspidy/graft-a2ui`, on `@a2ui/web_core`) |
| Core hooks | `packages/core/src/build/format.ts` |
| WordPress | `hosts/wordpress/adapter/src/a2ui.ts`, `src/client/a2ui.tsx` (@swissspidy/a2ui-wp) |
| EmDash | `hosts/emdash/adapter/src/host/a2ui.ts` |
| Example builds | `examples/builds` (WordPress), `examples/emdash/builds` |
| Compiling | `graft compile` (the `--ui a2ui` flag of the time is gone: A2UI is the only format) |

What stays here is [`specs/submit-for-review.md`](specs/submit-for-review.md),
a two-step flow that was compiled end to end (checks phase included) and
that ADR 0009 refers to. The compiled builds, logs and verification
records of these runs were removed in November 2026: they targeted
surfaces two generations old and no longer passed `graft check`. They are
in the history of this directory (`git log -- experiments/a2ui`).

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
