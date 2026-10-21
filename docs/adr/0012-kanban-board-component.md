# ADR 0012: A board component in the Graft catalog

- Status: Proposed
- Date: 2026-10-21
- Builds on: [ADR 0001](0001-architecture.md), [ADR 0009](0009-a2ui.md)

## Context

An editorial board is a common request for WordPress: posts as cards in
columns by status, where moving a card changes the post's status
([`examples/specs/kanban-board.md`](../../examples/specs/kanban-board.md)).
It has to respect the viewer: a contributor can send a draft for review,
but cannot publish.

ADR 0009 says the catalog grows only when a spec shows a need. So the
board was first built from the catalog as it is
([`experiments/kanban/catalog-only.json`](../../experiments/kanban/catalog-only.json)):
a Row of three Columns, each a heading and a Table of the posts in that
status (three `computed` filters over one `posts.list` source), with
"Pending review →", "← Draft", "Published →" and "← Pending review" as row
actions, each `visible` behind `can`.

It works. It passes the same eleven frozen checks as the board below, in
a WordPress sandbox. Status logic is not what the catalog lacks. What it
lacks:

- **Dragging.** Moving a card by dragging it is what makes a board a
  board, and nothing in the catalog can do it. A build cannot add it:
  builds contain no code (ADR 0009 removed `$fn` and widgets), and
  generating code for one customization would bring back everything that
  removal fixed: code nobody reviews, that breaks when the host changes.
- **Layout.** Three wp-admin list tables side by side give each column a
  third of the page for a title, author, age and an actions column. A
  board is cards, not rows.
- **Size.** The catalog-only build is ten components, three `computed`
  lists and the card fields written out three times (4.6 KB of UI,
  events and data). The board is one component (2.7 KB). Every repetition
  is a place for a compiler to make one column differ from the others.

## Decision

### Board is a catalog component, drawn by the host

`Board` joins the `graft:wordpress` catalog. It is defined once in
`@swissspidy/graft-a2ui` (`BOARD_COMPONENT`, with a zod schema and a
guide for the compiler), and a host that can draw it adds it to its
catalog; EmDash does not, so its validator refuses a Board as an unknown
component.

```json
{
  "id": "root",
  "component": "Board",
  "items": { "path": "/posts/items" },
  "columnBy": "status",
  "columns": [{ "id": "draft", "title": "Draft", "empty": "No drafts." }, …],
  "fields": [{ "id": "title", "label": "Title", "primary": true }, { "id": "author/name", "label": "Author" }, …],
  "moves": [
    {
      "id": "publish", "label": "Published →", "from": "pending", "to": "publish",
      "visible": { "call": "can", "args": { "scope": "posts.status:write" } },
      "action": { "event": { "name": "publish", "context": { "id": { "path": "id" } } } }
    }
  ]
}
```

- `columnBy` is a JSON Pointer into each item; a card goes in the column
  whose `id` equals its value. Items of no column are not drawn, and
  every column is drawn, empty or not.
- `fields` are Table fields: the primary one is the card's title, the
  others are its lines, formatted by the same cells as tables
  (`adapter/src/cells.ts`).
- `moves` are row actions with a `from` and a `to`. A card offers the
  moves out of its column whose `visible` holds in its scope, where `can`
  refines on the post as in a table row.

The validator checks what the schema cannot: columns are distinct, every
move goes between two of them and not to its own column, and no two moves
share a `from` and `to` (a drop would be ambiguous).

### It is reviewed code, not generated code

The board is about 200 lines of React in the WordPress renderer
(`adapter/src/client/board.tsx`), drawn with `@wordpress/components`
(`Card`, `Button`), written and reviewed once, versioned with the
catalog, and shared by every build that uses it. Builds stay data: the
board's columns, fields and moves are props the validator checks, the
compiler writes and the upgrade ladder migrates like any other.

The alternative, letting a build ship its own drag-and-drop code, fails
every property Graft exists for: it cannot be validated against a
schema, it is not covered by the verifier's snapshot, and it is exactly
the kind of code that breaks on a host upgrade with nobody around to fix
it.

### Dragging is a gesture for a move, not a way to change anything

Each move dispatches its A2UI action, an event the build binds to a
capability call, the same path as a button or a row action. Dragging
adds nothing to it:

- a card is draggable only if it has a move;
- while it is dragged, only the columns it has a move to take the drop
  (they are outlined, the others refuse it);
- dropping it runs that move, exactly as its button would.

So the keyboard (and screen reader) way to move a card is its buttons:
each card shows a button per move it may make, labelled with the target
column ("Published →") and named for the card. There is no move that only
dragging can make.

### How moves map to capability calls

Moves become events, events become capability calls, and the gateway
checks them as the viewer, as for every other action (ADR 0001):

| Move | Event | Capability | Scope (refined on the post) |
| --- | --- | --- | --- |
| Draft → Pending review | `send-for-review` | `posts.update_review_status` `{status: "pending"}` | `posts.review:write` (`can/edit`) |
| Pending review → Draft | `back-to-draft` | `posts.update_review_status` `{status: "draft"}` | `posts.review:write` (`can/edit`) |
| Pending review → Published | `publish` | `posts.update_status` `{status: "publish"}` | `posts.status:write` (`can/publish`) |
| Published → Pending review | `unpublish` | `posts.update_status` `{status: "pending"}` | `posts.status:write` (`can/publish`) |

The board needed one new capability. `posts.status:write` maps to
`edit_posts` and `publish_posts`, so a contributor holds no status scope
at all and could not even send a draft for review. The WordPress surface
now has `posts.update_review_status` (ability
`graft/post-update-review-status`) behind a new scope,
`posts.review:write` ("Send posts you can edit for review, or back to
draft", `edit_posts`). Its input only takes `draft` and `pending`, and its
permission check only moves posts that are drafts or pending now, so it
never publishes and never takes a post off the site, whoever calls it.
Widening `posts.status:write` instead would have handed every grant of it
to contributors.

The surface changed, so `surfaces/7.1.json` and the agency surface were
regenerated (`pnpm surface:generate`, `pnpm surface:agency`) and every
stored build re-stamped with `graft build --fix-refs`.

### How the verifier sees a board

The walk (`walkA2UI`) draws a board as a Row of Columns, each a heading
and a table of that column's cards, with the moves out of it as row
actions. So:

- the snapshot needs nothing new: `rows` reads the first column (Draft),
  `cell` reads a card's lines by label, `text` sees headings and empty
  lines, and `action` sees moves by id, per card, available or not;
- a check written for a board passes or fails the same way for the
  catalog-only build, which is how the same eleven checks prove both;
- dragging is not simulated: a drop runs the same action as the button,
  which the browser renderer's unit tests show
  (`adapter/test/board.test.tsx`), and the e2e tests drag a card in
  wp-admin.

### Checks can call what the UI does not offer

"A move the viewer may not make is refused by the gateway even when it is
called directly" was not checkable: a check's step can only use an action
the viewer is offered. Checks now have:

- a step `{"action": "<id>", "row": {...}, "direct": true}`, which calls
  the action's capability even when it is hidden or disabled, as anyone
  calling `/graft/v1/call` could; a refusal does not fail the check;
- an expectation `{"refused": "<id>", "row": {...}}`: a direct call of
  that action was refused.

The board's `refused` check has a contributor call `publish` on their
pending post directly and expects a refusal and the post still pending.
It is generic: any spec can now prove its host refuses what its UI hides.

## Results

- The spec's eleven checks pass for both the board build and the
  catalog-only build, verified in a WordPress sandbox (`pnpm graft
  verify`).
- `pnpm test:e2e` (`e2e/kanban.spec.ts`): a contributor moves their own
  card to Pending review with the keyboard, cannot drop it on Published,
  and is refused when calling `publish` directly; an editor drags it to
  Published and moves it back with its button.
- Unit tests cover the board's lanes, snapshot, validation and
  verification (`packages/a2ui/test/board.test.ts`), and the WordPress
  board's buttons, drag targets and drops, through the real A2UI renderer
  (`adapter/test/board.test.tsx`).
- The build was written by hand: no model key was available. The catalog
  guide describes the board to the compiler (`BOARD_GUIDE`), but no
  compile has used it yet.

## Consequences

- The catalog has its first component that exists for an interaction
  rather than for data: drag-and-drop. Others like it (sorting a list by
  hand, a calendar) should meet the same bar: a spec that needs it, a
  catalog-only attempt that falls short, and a gesture that only triggers
  actions the build already binds.
- A board is only as permissive as its moves' `visible` and the
  capabilities behind them; the gateway refuses the rest. A wrong
  `visible` is caught by checks, and a wrong capability by the gateway.
- Not covered: reordering cards within a column (no capability stores an
  order), columns from a taxonomy or custom field rather than status
  (`columnBy` can point at one, but no example uses it), and more than
  100 posts (`posts.list`'s page size).
- The verifier's `rows` reads only the first table, so checks name a
  card's column through the moves it offers. A `rows` that names its
  table would make column checks direct; it would need tables to carry a
  title.
