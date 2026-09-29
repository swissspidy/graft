---
graft: 1
id: quick-approve
host: wordpress
mount:
  slot: posts.list.row-actions
audience: [editor, administrator]
permissions:
  - posts:read
  - posts.status:write
---

# Quick approve from the posts list

Editors can publish a pending post straight from the Posts screen without
opening it.

## Acceptance criteria

- Pending posts show an "Approve" row action {#shown-on-pending}
- Posts in any other status do not show it {#hidden-otherwise}
- Clicking "Approve" publishes the post and updates its status in the list {#approve}
- Users who cannot publish the post do not see the action {#requires-publish}

## Out of scope

- Bulk approval
