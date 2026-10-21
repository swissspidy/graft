# ADR 0012: Dragging as another way to press a button

- Status: Proposed
- Date: 2026-10-21
- Builds on: [ADR 0001](0001-architecture.md), [ADR 0009](0009-a2ui.md)

## Context

An editorial board is a common request for WordPress: posts as cards in
columns by status, where moving a card changes the post's status
([`examples/specs/kanban-board.md`](../../examples/specs/kanban-board.md)).
It has to respect the viewer: a contributor can send a draft for review,
but cannot publish.

ADR 0009 says the catalog grows only by what a spec shows is missing.
So the board was first built from the catalog as it was
([`experiments/kanban/catalog-only.json`](../../experiments/kanban/catalog-only.json)):
a Row of three Columns, each a heading and a Table of the posts in one
status, with the moves as row actions behind `can`. It passed the spec's
checks in a WordPress sandbox. The status logic, the permissions and the
moves were all expressible. Two things were not:

- **Dragging a card.** This is what makes a board a board. Builds
  contain no code (ADR 0009 removed `$fn` and widgets), so a build cannot
  add it.
- **Saying where a card is.** The verifier's `rows` read only the first
  table, so checks could only infer a card's column from the moves it
  offered.

A first version of this ADR added a `Board` component: items grouped by a
field, cards, moves and dragging, all in one. That put three things the
catalog could already do inside one component that did only one new
thing. It was reusable only for boards, and it was a domain component in
a catalog of primitives. A board is a composition. What the catalog
lacked was the drag.

## Decision

### Three props, no new component

| Prop | On | Means |
| --- | --- | --- |
| `draggable` | Card | The card can be dragged. |
| `dropTarget: "<name>"` | Column, Row, Card | The container takes dropped cards, under this name. |
| `dropTarget: "<name>"` | Button | Dropping the Card this button is in on the container named `<name>` presses this button. |

**A drop is only another way to press a button the viewer already has.**

- A container takes a dragged card only if the card shows an enabled
  Button for it: one whose `visible` holds and whose `checks` pass.
- The drop presses that Button: its action, its event, its capability
  call through the gateway as the viewer, its `then` and its notice.
- The Button itself stays on the card. It is how keyboard and screen
  reader users move the card, and there is no move only dragging can
  make.

The validator refuses a Button with a `dropTarget` outside a draggable
Card or naming no container, and a draggable Card with no such Button.

### The board, composed

[`examples/builds/kanban-board.json`](../../examples/builds/kanban-board.json):

```
Row
├── Column  dropTarget "draft"     — Text "Draft", Text "No drafts." (when empty), a template of `card` over /draft
├── Column  dropTarget "pending"   — …
└── Column  dropTarget "publish"   — …

card: Card draggable
└── Column: Text title, Text author, Text "3 days ago",
            Row of Buttons, each visible when the post's status is its source column and `can` allows it:
            "Pending review →" (dropTarget "pending"), "← Draft" ("draft"),
            "Published →" ("publish"), "← Pending review" ("pending")
```

`/draft`, `/pending` and `/publish` are `computed` filters of one
`posts.list` source. A card's `can` refines on its post, as in a table
row. Each Button names its card for assistive technology through A2UI's
`accessibility.label` ("Move “Interview” to Published").

The same props make other things without new components: a list sorted
into categories, posts assigned to people by dropping them on a person,
a card dropped on a "Trash" Card. Wherever the build already has the
button, it can have the drag.

It costs size. The composed board is 27 components (5.3 KB of UI,
events and data), against one component (2.7 KB) for the `Board` it
replaces. Most of that is button labels and the three columns written
out. The structure is the same as the catalog-only build, which the
checks already proved writable.

### How the verifier sees it

The snapshot gains two things, both generic:

- **A template of Cards is a list.** Each Card reads as a row, labelled
  by its first text, with its Texts as cells named by their component ids
  and its Buttons as the row's actions. So `rows`, `cell` and `action`
  work on cards as on table rows. No example built before this used a
  Card, so no existing check reads differently.
- **Lists know where they are.** A table or card list records the
  `dropTarget` of the container it is drawn in (`zone`), and `rows`
  takes `"in": "<name>"`: `{"rows": ["Interview"], "in": "pending"}`.
  Without `in`, `rows` reads the first list, as before.

- **A hidden Button is there, not available.** It is in the snapshot as
  an action the viewer cannot use, as a hidden table row action always
  was. So a direct call (below) can name the Publish button a contributor
  never sees. Hosts draw nothing for it, as before.

Checks can drag: the step `{"drop": {"title": "Outline"}, "on":
"pending"}` presses the card's button for `pending`. The step fails when
the viewer has no such button, so a drop is verified exactly as the
browser allows it. The board's checks drag cards for both review and
publishing, and use the buttons for the moves back.

### How moves map to capability calls

| Move | Event | Capability | Scope (refined on the post) |
| --- | --- | --- | --- |
| Draft → Pending review | `send-for-review` | `posts.update_review_status` `{status: "pending"}` | `posts.review:write` (`can/edit`) |
| Pending review → Draft | `back-to-draft` | `posts.update_review_status` `{status: "draft"}` | `posts.review:write` (`can/edit`) |
| Pending review → Published | `publish` | `posts.update_status` `{status: "publish"}` | `posts.status:write` (`can/publish`) |
| Published → Pending review | `unpublish` | `posts.update_status` `{status: "pending"}` | `posts.status:write` (`can/publish`) |

The board needed one new capability. `posts.status:write` maps to
`edit_posts` and `publish_posts`, so a contributor held no status scope
at all and could not even send a draft for review.

- **The new capability:** the WordPress surface now has
  `posts.update_review_status` (ability `graft/post-update-review-status`).
  Its input only takes `draft` and `pending`, and its permission check
  only moves posts that are drafts or pending now. So it never publishes
  and never takes a post off the site, whoever calls it.
- **The new scope:** it sits behind `posts.review:write` ("Send posts you
  can edit for review, or back to draft", `edit_posts`).
- **Why not widen the old scope:** widening `posts.status:write` instead
  would have given publishing rights to contributors wherever it is
  granted.

The surface changed, so `surfaces/7.1.json` and the agency surface were
regenerated (`pnpm surface:generate`, `pnpm surface:agency`), and every
stored build was re-stamped with `graft build --fix-refs`.

### Checks can call what the UI does not offer

The criterion "A move the viewer may not make is refused by the gateway
even when it is called directly" had no possible check: a step could
only use an action the viewer is offered. Checks now have:

- a step `{"action": "<id>", "row": {...}, "direct": true}`, which calls
  the action's capability even when it is hidden or disabled, as anyone
  calling `/graft/v1/call` could; a refusal does not fail the check;
- an expectation `{"refused": "<id>", "row": {...}}`: a direct call of
  that action was refused.

### WordPress draws it

`adapter/src/client/drag.tsx` wraps a2ui-wp's Card, Column, Row and
Button. It is about 150 lines, reviewed once and shared by every build.

- A draggable Card collects what its Buttons register (target → press)
  while they are drawn and enabled.
- Dragging it publishes that map.
- A container with a `dropTarget` takes the drop only when the map has
  its name, outlines itself while it would, and presses the button on
  drop.
- Hosts that cannot drag, EmDash's Block Kit for one, ignore the props
  and draw the buttons. Block Kit has no cards either: it draws a list of
  Cards as a table, one column per Text.

## Results

- **Sandbox:** the spec's eleven checks pass in a WordPress sandbox,
  including drags for review and publishing.
- **Mutation:** a mutant whose Publish button skips `can` fails exactly
  the `not-offered` check.
- **E2E** (`pnpm test:e2e`, `e2e/kanban.spec.ts`):
  - a contributor moves their own card to Pending review with the
    keyboard, cannot drop it on Published, and is refused when calling
    `publish` directly;
  - an editor drags it to Published and moves it back with its button.
- **Unit tests:**
  - card lists, zones, drop steps and the drag validation
    (`packages/a2ui/test/drag.test.ts`);
  - the WordPress drag layer, which the real A2UI renderer draws from
    the example build: buttons, which columns accept or refuse a card,
    and drops (`adapter/test/drag.test.tsx`).
- **No compile yet:** the build was written by hand, because no model
  key was available. The catalog guide describes dragging to the
  compiler, but no compile has used it yet.

## Consequences

- The catalog's first interaction is a way to trigger what a build
  already binds, not a new kind of effect. Other gestures should meet the
  same bar: they press a button that is there for everyone else.
- A drop is as permissive as the button it presses. A wrong `visible` is
  caught by checks, and a wrong capability by the gateway.
- Not covered:
  - reordering cards within a column (no capability stores an order);
  - dropping anything but a Card;
  - more than 100 posts (`posts.list`'s page size).
