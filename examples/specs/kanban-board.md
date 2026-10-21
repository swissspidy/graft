---
graft: 1
id: kanban-board
host: wordpress
mount:
  slot: admin.page
  menu:
    parent: posts
    title: Board
audience: [editor, author, contributor]
permissions:
  - posts:read
  - posts.review:write
  - posts.status:write
---

# Editorial board

Everyone who writes sees the posts they can edit as cards on a board, one
column per status: Draft, Pending review and Published. Moving a card to
the next or previous column changes the post's status, as far as the
viewer is allowed to: contributors can send their drafts for review and
take them back, but only people who may publish can move a card to
Published or back out of it.

## Acceptance criteria

- The board has a Draft, a Pending review and a Published column, and
  each post is in the column of its status {#columns}
- Cards show the post's title, its author, and how many days ago it was
  last updated {#card}
- Moving a draft to the next column sends it for review, and moving it
  back makes it a draft again {#review}
- Editors move a pending post to the next column to publish it, and a
  published post back to send it to review again {#publish}
- Moves the viewer may not make are not offered: contributors cannot move
  a card into or out of Published {#not-offered}
- A move the viewer may not make is refused by the gateway even when it is
  called directly {#refused}
- An empty column still shows, with a line saying it is empty {#empty-columns}

## Out of scope

- Scheduled and private posts
- Reordering cards within a column
- Editing posts from the board
