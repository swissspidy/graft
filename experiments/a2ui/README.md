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
layout, text and input components plus a Table, and what the example specs
needed beyond the basic catalog:

- `visible` on every component (A2UI cannot hide anything);
- functions: `if` (A2UI has no conditional), `can` (the host's permission
  check), `count`, `daysSince`, list functions (`filter`, `map`,
  `distinct`, `sort`, `slice`, `join`) and strings (`lower`, `upper`,
  `replace`);
- a local action, `set`, writing a value into the data model (which author
  is picked), as A2UI's `functionCall` action;
- `actionId` on Button, so buttons a template draws per item get ids the
  checks can name (`author-ada`);
- two data model sections in the build: `initial` (set once when drawn,
  e.g. a form seeded from the slot) and `computed` (recomputed whenever the
  model changes, e.g. the rows filtered by the picked author). Templates and
  tables only bind to pointers, so derived lists have to live in the model.

Every data pointer is a JSON Pointer, Table field ids included
(`author/name`, relative to the row).

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

| Spec | Tree build has | Attempts | Checks |
| --- | --- | --- | --- |
| review-queue | table | 2 | 5/5 |
| publish-checklist | widget + 50 lines of JS | 1 | 13/13 |
| pending-by-author | widget + JS | 1 | 5/5 |
| headline-check | table + `$fn` JS | 1 | 6/6 |
| stale-drafts | table, `$daysSince` | 1 | 5/5 |
| quick-approve | row action | 1 | 4/4 |
| waiting-posts | table | 1 | 3/3 |

All seven example specs compile to A2UI against their frozen checks, and
none of the A2UI builds has code.

- review-queue's first attempt gated Approve on `{"path": "can.publish"}`:
  a dotted path, which as a JSON Pointer is one key named `can.publish`, so
  Approve was never available. Table field ids were Graft's dotted paths
  then; they are JSON Pointers now, and static validation names a dotted
  pointer with its fix. (That run predates both; the later ones had no such
  attempt.)
- publish-checklist needed no code. The tree build is a widget with about
  50 lines of JavaScript run in the host's function sandbox; the A2UI build
  is declarative: inputs bound to `/form/*` (seeded from the slot through
  `initial`), checklist lines as `if` + `formatString` + `length`/`regex`
  over the bound values, and Publish gated by A2UI's own Button `checks`
  (disabled with the reason, rather than hidden) plus `visible` from `can`.
- pending-by-author's widget state machine became `computed` lists
  (`distinct` authors, rows `filter`ed by the picked author), an author
  button per item from a template, each a local `set` with an `actionId`
  from the author's name, and "Everyone" setting it back.
- headline-check's `$fn` became `join` over `if`/`regex` per rule. It works,
  but A2UI expressions have no local names: the three rules are written out
  three times (the verdict, whether there is any problem, the tone). A
  catalog would want a way to name a value per row.
- quick-approve's root is one Button with `visible` from the slot's post.

**In WordPress** (`npx tsx experiments/a2ui/server.ts`, then the three
`render*.ts` scripts), drawn by a2ui-wp's renderer:

- `render.ts`: the review queue in wp-admin (above).
- `render-editor.ts`, the publish checklist in the block editor sidebar,
  as `hosts/wordpress/e2e` checks the tree version: fields prefilled,
  checklist follows typing, Publish disabled until saved, Save refused
  while the editor has unsaved changes of its own (the tree runtime's
  guard, ported), Save reloads, Publish publishes.
- `render-dashboard.ts`, the Dashboard: pending-by-author's author buttons
  filter the rows and Everyone restores them (local state, no calls),
  Approve publishes through the gateway; headline-check and stale-drafts
  draw their verdicts and ages; waiting-posts, which the e2e site leaves
  unapproved, is not drawn.

All pass with no page errors. (The e2e site has one pending author, so the
filter is only weakly exercised in the browser; the frozen checks use two.)
The author buttons stack instead of sitting in a row: a2ui-wp's `Row`
inside a `Row` takes the full width.

**Writing checks for A2UI** (`npx tsx experiments/a2ui/checks.ts pending-by-author publish-checklist stale-drafts`):
the whole compiler, the checks phase included, with the A2UI catalog
described where Graft's components were. Then the example's tree build
against the same fresh checks, as a cross-check.

| Spec | Fresh checks | A2UI build | Tree build on the fresh checks |
| --- | --- | --- | --- |
| pending-by-author | 6 | fails 1 in 3 attempts | fails the same 1 |
| publish-checklist | 16 | passes, 1 attempt | fails 7: input id `headline`, not `title` |
| stale-drafts | 7 | passes, 2 attempts | fails 5: column "Last updated", text "47" |

The checks phase works unchanged for A2UI. Where the tree build fails,
the checks named things differently (ids, labels): what a check calls an
action, input or column is a contract the checks phase sets, as before.
The other failures are flaws in Graft's checks that do not depend on the
UI format:

- pending-by-author: a check expects the *text* "Everyone", which is a
  button's label. Snapshots of either format do not count labels as text,
  so no build can pass it.
- stale-drafts: a check expects the text "47" (days). Snapshots do not
  count table cells as text either, so the A2UI build's second attempt
  *added* an "Oldest draft, days since last update" line the spec never
  asked for, to show "47" outside the table. The checks writer should be
  told to use `cell` and `action` expectations for those (or snapshots
  should count them as text); either way it is a change to Graft's check
  vocabulary, not to A2UI.

**Upgrades** (`npx tsx experiments/a2ui/upgrade.ts`): the WordPress canary's
synthetic host changes against every A2UI build (the handwritten
review-queue and the seven compiled ones), with an A2UI ladder:

- reverify, unless the build's slot is gone or deprecated;
- migrate: declared renames ([`migrate.ts`](migrate.ts)) of capabilities in
  `data` and `events`, scopes in `can` calls, and the slot in `mount`;
- re-anchor: the slot's successor, or the one slot of the same kind that
  provides every `/slot/...` prop the surface reads;
- regenerate (`REGENERATE=1`): the A2UI compiler with the frozen checks and
  the old build as reference;
- needs_approval when the new host wants scopes beyond the grant.

| Scenario | A2UI builds | Same as the tree builds? |
| --- | --- | --- |
| noop | all survived | yes |
| rename-list-capability | migrated: every build reading `posts.list` (6); survived: the other 2 | yes |
| move-row-actions | reanchored: quick-approve; survived: the rest | yes |
| change-list-input | regenerated: every `posts.list` build (6), each in one attempt; survived: the other 2 | yes |
| widen-publish-scope | needs_approval: the 5 that change status; survived: the 3 read-only | yes |
| remove-status-update | failed: the 5 that change status; survived: the 3 read-only | yes |
| no-functions | **all survived** | no: tree headline-check, pending-by-author and publish-checklist fail |
| no-widgets | **all survived** | no: tree pending-by-author and publish-checklist fail |

"Same as the tree builds" compares with the outcomes the canary test
expects for the example tree builds (stale-drafts and waiting-posts are
not in that corpus; theirs follow the same pattern).

The ladder works unchanged in shape. The difference is what hosts can
break: an A2UI build's components and client functions belong to the
catalog, so host releases cannot rename them (Graft surface migrations of
components and props do not apply); catalog changes would be versioned on
their own, as a new catalog id. And builds with no code survive a host
that stops running code: three of the seven examples needed code as trees,
none does as A2UI.

## What it took

- Core: `createSnapshotEmitter()` (the snapshot emitter, shared by any UI
  format) and a `snapshot` option on `verifyBuild` for a build whose UI is
  not a tree, given what the viewer typed so far; a local action in such a
  UI is kept with what the viewer typed. Nothing else in core changed.
- [`compiler.ts`](compiler.ts): output schema, prompt, assembly, static
  validation and the attempt loop. Validation covers ids, references,
  reachability, known functions, bound events, input bindings, local
  actions, dotted pointers, data model keys, and data source and event
  inputs against the capability's input schema (with `$context` and
  `$slot` placeholders exempt); [`validate-test.ts`](validate-test.ts)
  breaks a build each way. A2UI's component list is
  already flat, so it fits structured outputs (no recursive schemas)
  without the tree's flatten-and-reassemble step.
- a2ui-wp fix: a `longText` TextField's label pointed at nothing
  (TextareaControl ignores `id` for its label). Should go upstream.
- [`snapshot.ts`](snapshot.ts): reads an A2UI surface into Graft's semantic
  snapshot with a2ui-wp's resolver.
- [`client.tsx`](client.tsx): the runtime glue (one processor per mounted
  build, `initial`, `computed`, `set`, events through the gateway, the
  editor guard), and the Table: Graft's WordPress table, given the A2UI
  row actions and dispatching their events.
- [`page.php`](page.php): mounts the A2UI builds next to the tree ones (an
  admin page, an editor panel, Dashboard widgets), each served as its
  approved customization, so the gateway authorizes calls against that
  spec's capabilities and grant.

## What it did not cover

- Storing, attaching and approving A2UI builds through Graft itself: the
  build schema, `graft site push`, the plugin's build storage and its refs
  checks still expect a tree. Here the A2UI builds ride on the approved
  tree builds of the same specs.
- Rendering in the posts list's row actions (quick-approve is verified, not
  drawn) and in EmDash (its own catalog on Kumo).
- Widgets beyond what the examples need: a state machine that is not a
  filter or a form (multi-step flows, undo) may still want code, or more
  local actions.
- A2UI's own `checks` (input validation) next to Graft's checks: the names
  collide in one build file.
- Data source inputs take literals and `$slot`; Graft's other expressions
  are not evaluated there.
