# Kanban board from the base catalog

Before the catalog could drag
([ADR 0012](../../docs/adr/0012-drag-and-drop.md)), the
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

It passes the eleven checks it carries in a WordPress sandbox. Those are
the spec's first checks: the [board build](../../examples/builds/kanban-board.json)
now carries stronger ones, which say which column a card is in (`"in"`)
and drag cards (`"drop"`), and which a build of tables without drop
targets cannot pass.

```sh
pnpm graft verify --surface hosts/wordpress/plugin/surfaces/7.1.json --spec examples/specs experiments/kanban/catalog-only.json
```

What it cannot do is let a card be dragged, and three list tables side by
side leave each column a third of the page. The board build is the same
shape, with draggable Cards in place of the tables. Both builds were written by
hand (no model key was available in the session that wrote them).
