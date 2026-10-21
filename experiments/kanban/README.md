# Kanban board from the base catalog

Before the board became a catalog component
([ADR 0012](../../docs/adr/0012-kanban-board-component.md)), the
[kanban spec](../../examples/specs/kanban-board.md) was built from the
catalog as it was: [`catalog-only.json`](catalog-only.json).

- A Row of three Columns, each a heading and a Table of the posts in one
  status. One `posts.list` source loads drafts, pending and published
  posts; three `computed` filters split it by status.
- The moves are row actions: "Pending review →" on drafts, "← Draft" and
  "Published →" on pending posts, "← Pending review" on published ones,
  each `visible` behind `can` and bound to the same events as the board.
- The card fields (title, author, "Updated") are written out once per
  table.

It passes the spec's eleven frozen checks in a WordPress sandbox, the same
checks the [board build](../../examples/builds/kanban-board.json) passes:

```sh
pnpm graft verify --surface hosts/wordpress/plugin/surfaces/7.1.json --spec examples/specs experiments/kanban/catalog-only.json
```

What it cannot do is let a card be dragged, and three list tables side by
side leave each column a third of the page. Both builds were written by
hand (no model key was available in the session that wrote them).
