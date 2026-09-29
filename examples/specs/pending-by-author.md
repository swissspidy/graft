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
  - posts.status:write
---

# Pending by author

Editors see on their Dashboard the posts waiting for review, and can
narrow them down to one author at a time, and approve them, without
leaving the Dashboard.

## Acceptance criteria

- Lists pending posts only, with a button for each of their authors {#authors}
- Choosing an author lists only that author's pending posts {#filter}
- "Everyone" lists every pending post again {#everyone}
- Editors publish a pending post with its Approve button, and it leaves the list {#approve}

## Out of scope

- Editing posts from the Dashboard
