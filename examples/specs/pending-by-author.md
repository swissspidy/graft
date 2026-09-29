---
graft: 1
id: pending-by-author
host: wordpress
mount:
  slot: dashboard.widget
  title: Pending by author
audience: [editor, administrator]
permissions:
  - posts:read
---

# Pending by author

Editors see on their Dashboard the posts waiting for review, and can
narrow them down to one author at a time without leaving the Dashboard.

## Acceptance criteria

- Lists pending posts only, with a button for each of their authors {#authors}
- Choosing an author lists only that author's pending posts {#filter}
- "Everyone" lists every pending post again {#everyone}

## Out of scope

- Approving posts from the Dashboard
