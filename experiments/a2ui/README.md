# Proof of concept: A2UI as Graft's UI format

Question: can a Graft build carry its UI as an [A2UI](https://a2ui.org/) v0.9
surface instead of a Graft tree, with the rest of Graft (spec, frozen checks,
gateway, permissions, upgrades) unchanged?

[`review-queue.a2ui.json`](review-queue.a2ui.json) is `examples/builds/review-queue.json`
with its `tree` replaced:

- `ui`: an A2UI surface. A flat component list (`Column`, `Text`, and a
  `Table`, which A2UI's basic catalog does not have), data bound with JSON
  Pointers (`{"path": "/queue/items"}`, relative inside rows), and the
  Approve button as an A2UI action event:
  `{"event": {"name": "approve", "context": {"id": {"path": "id"}}}}`.
  Visibility is the catalog function `can`: `{"call": "can", "args": {"scope": "posts.status:write"}}`.
- `events`: binds each event name to a host capability, with the event's
  context in its input (`{"$context": "id"}`), and the same `then` and
  `notice` a `$call` has.
- Everything else (spec, mount, data sources, the five checks, refs) is the
  original build's, checks byte for byte.

No agent runs. The Graft runtime plays the A2UI server: it fills the data
model from the build's data sources and answers action events with
capability calls through the gateway. Using the customization stays free of
inference.

The A2UI side is [swissspidy/a2ui-wp](https://github.com/swissspidy/a2ui-wp)'s
protocol core and React renderer, copied into [`packages/a2ui`](../../packages/a2ui)
(still GPL-2.0-or-later until its relicense lands; see that README).

The `graft:wordpress` catalog ([`catalog.ts`](catalog.ts)) is A2UI's basic
layout, text and input components plus a Table, and two things the basic
catalog lacks: `visible` on every component, and functions `if` (A2UI has
no conditional), `count` (a length to show), `can` (the host's permission
check) and `daysSince`.

## Results

**Verification** (`npx tsx experiments/a2ui/verify.ts`): the five unchanged
review-queue checks, in a WordPress sandbox through real ability calls.

| Build | pending-only | columns | approve | contributors-no-approve | empty-state |
| --- | --- | --- | --- | --- | --- |
| Graft tree (baseline) | ✔ | ✔ | ✔ | ✔ | ✔ |
| A2UI surface | ✔ | ✔ | ✔ | ✔ | ✔ |
| A2UI, Approve shown to everyone | ✔ | ✔ | ✔ | ✘ | ✔ |
| A2UI, Approve sets status to draft | ✔ | ✔ | ✘ | ✔ | ✔ |

The broken variants fail exactly the check that covers the mistake:
"Expected "approve" not to be available for title "Draft A", but it is" and
"Expected post {"status":"publish",...}, found {..."status":"draft"...}".

**In wp-admin** (`npx tsx experiments/a2ui/server.ts`, then
`npx tsx experiments/a2ui/render.ts`): Posts → Review queue (A2UI) drawn by
a2ui-wp's renderer and catalog plus the Graft Table, against the e2e site.

- Columns, the pending posts, and Approve for editors.
- Approve publishes the post through `/graft/v1/call` (WordPress confirms
  the status), removes the row and shows "Post published."
- Contributors see their pending posts without Approve.
- No page errors. It matches the tree-rendered Review queue: the A2UI
  Table is a thin adapter around Graft's own WordPress table, so rows,
  cells and actions are drawn by the same component in both formats. Only
  the gap under the heading differs (A2UI `Column` against Graft `stack`).

**Compiling** (`ANTHROPIC_API_KEY=... npx tsx experiments/a2ui/compile.ts review-queue publish-checklist`):
Claude writes the surface, data sources and event bindings against each
spec's frozen checks (from `examples/builds`), with the same loop as the
compiler's tree phase: structured output, assembly, static validation,
verification in the sandbox, failures fed back. Results in [`compiled/`](compiled/),
each with a log of every attempt.

| Spec | Attempts | Checks |
| --- | --- | --- |
| review-queue | 2 | 5/5 |
| publish-checklist | 1 | 13/13 |

- review-queue's first attempt gated Approve on `{"path": "can.publish"}`:
  a dotted path, which as a JSON Pointer is one key named `can.publish`, so
  Approve was never available. The catalog invites this: Table field ids
  are Graft's dotted paths (`author.name`) while bindings are JSON
  Pointers. Pick one.
- publish-checklist needed no code. The tree build is a widget with about
  50 lines of JavaScript run in the host's function sandbox; the A2UI build
  is declarative: inputs bound to `/form/*` (seeded from the slot through
  `initial`), checklist lines as `if` + `formatString` + `length`/`regex`
  over the bound values, and Publish gated by A2UI's own Button `checks`
  (disabled with the reason, rather than hidden) plus `visible` from `can`.
- **In the block editor** (`npx tsx experiments/a2ui/render-editor.ts`,
  as `hosts/wordpress/e2e` checks the tree version): fields prefilled,
  checklist follows typing, Publish disabled until saved, Save reloads,
  Publish publishes. All pass, no page errors. Screenshots:
  `test-results/a2ui-checklist-*.png`.

**Upgrades** (`npx tsx experiments/a2ui/upgrade.ts`): the WordPress canary's
synthetic host changes against the handwritten and both compiled A2UI
builds, with an A2UI ladder ([`migrate.ts`](migrate.ts) for declared
renames: capabilities in `data` and `events`, scopes in `can` calls, the
slot in `mount`). The tree column is the outcome the canary test expects
for the same specs' tree builds.

| Scenario | review-queue (both) | Tree | publish-checklist | Tree |
| --- | --- | --- | --- | --- |
| noop | survived | survived | survived | survived |
| rename-list-capability | migrated | migrated | survived | survived |
| move-row-actions | survived | survived | survived | survived |
| change-list-input | regenerated¹ | regenerated | survived | survived |
| widen-publish-scope | needs_approval | needs_approval | needs_approval | needs_approval |
| remove-status-update | failed | failed | failed | failed |
| no-functions | survived | survived | **survived** | failed |
| no-widgets | survived | survived | **survived** | failed |

¹ With `REGENERATE=1`: the A2UI compiler with the old build as reference
and the frozen checks; both builds regenerated in one attempt.

The ladder works unchanged in shape. The difference is what hosts can
break: an A2UI build's components and client functions belong to the
catalog, so host releases cannot rename them (Graft surface migrations of
components and props do not apply); catalog changes would be versioned on
their own, as a new catalog id. And a build that needs no code survives a
host that stops running code.

## What it took

- Core: `createSnapshotEmitter()` (the snapshot emitter, shared by any UI
  format) and a `snapshot` option on `verifyBuild` for a build whose UI is
  not a tree, given what the viewer typed so far. Nothing else in core
  changed.
- [`compiler.ts`](compiler.ts): output schema, prompt, assembly, static
  validation (ids, references, reachability, known functions, bound
  events, input bindings) and the attempt loop. A2UI's component list is
  already flat, so it fits structured outputs (no recursive schemas)
  without the tree's flatten-and-reassemble step.
- a2ui-wp fix: a `longText` TextField's label pointed at nothing
  (TextareaControl ignores `id` for its label). Should go upstream.
- [`snapshot.ts`](snapshot.ts): reads an A2UI surface into Graft's semantic
  snapshot with a2ui-wp's resolver (about 120 lines with the Table).
- [`client.tsx`](client.tsx): the runtime glue, and the Table: Graft's WordPress
  table, given the A2UI row actions and dispatching their events.
- The A2UI page is served as the approved review-queue customization, so the
  gateway authorizes calls against that build's capabilities and grant (the
  same ones).

## What it did not cover

- Validating event and data inputs against capability schemas (the
  sandbox call catches it, later), refs as the gateway checks them, and the
  checks phase (checks came from the example builds, frozen).
- The editor's own unsaved changes: the tree runtime refuses to Save while
  the editor has unsaved edits of its own; this client does not. That is
  host runtime glue, not the build.
- Specs that need real state machines (filtering, switching views): the
  widget cases beyond forms. A2UI's data model plus `if` covered the
  checklist; a list filtered by a picked author needs a filter function in
  the catalog or local actions.
- A2UI's own `checks` (input validation) next to Graft's checks: the names
  collide in one build file.
- Data source inputs are literals here; Graft evaluates expressions there.
