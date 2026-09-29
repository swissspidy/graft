---
graft: 1
id: publish-queue
host: emdash
mount:
  slot: admin.page
  title: Publish queue
audience: [editor, admin, contributor]
permissions:
  - content:read
  - content.status:write
---

# Publish queue

Editors see the posts that are still drafts, oldest first, and publish them
with one click.

## Acceptance criteria

- Only draft posts are listed {#drafts-only}
- Columns: title, author, last updated {#columns}
- "Publish" publishes the post and removes it from the list {#publish}
- Contributors cannot see the publish button {#contributors-no-publish}
- When there are no drafts, the page says "Nothing waiting" {#empty-state}
