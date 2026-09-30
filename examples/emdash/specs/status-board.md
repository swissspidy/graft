---
graft: 1
id: status-board
host: emdash
mount:
  slot: admin.page
  title: Status board
audience: [editor, admin, contributor]
permissions:
  - content:read
  - content.status:write
---

# Status board

Editors switch between the drafts and the published posts on one page,
see how many there are of each, and publish drafts or take posts offline
from the list.

## Acceptance criteria

- Shows the drafts first, and how many drafts and published posts there are {#drafts-first}
- "Published" lists only the published posts, and "Drafts" the drafts again {#switch}
- "Publish" on a draft publishes it, and it leaves the list {#publish}
- "Unpublish" on a published post takes it offline, and it leaves the list {#unpublish}
- Contributors see the lists, but cannot publish or unpublish {#contributors}

## Out of scope

- Scheduled posts
