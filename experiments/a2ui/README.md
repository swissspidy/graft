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
protocol core and React renderer, imported from a clone next to this
repository (`../swissspidy/a2ui-wp`), not copied: a2ui-wp is GPL-2.0-or-later
and Graft is Apache-2.0.

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
- No page errors. Next to the tree-rendered Review queue it is near
  identical (the PoC Table puts Approve under the title instead of in its
  own column).

## What it took

- Core: `createSnapshotEmitter()` (the snapshot emitter, shared by any UI
  format) and a `snapshot` option on `verifyBuild` for a build whose UI is
  not a tree. Nothing else in core changed.
- [`snapshot.ts`](snapshot.ts): reads an A2UI surface into Graft's semantic
  snapshot with a2ui-wp's resolver (about 120 lines with the Table).
- [`client.tsx`](client.tsx): the runtime glue and the Table for the browser.
- The A2UI page is served as the approved review-queue customization, so the
  gateway authorizes calls against that build's capabilities and grant (the
  same ones).

## What it did not cover

- Validation against the surface (`validateBuild`, `refs`), the compiler
  (prompt, structured output, assembly), interactive widgets, inputs,
  `$daysSince`/`$fn` equivalents, and the upgrade ladder's migrations
  (renames would now rename A2UI component types and properties).
- A2UI's own `checks` (input validation) next to Graft's checks: the names
  collide in one build file.
- Data source inputs are literals here; Graft evaluates expressions there.
