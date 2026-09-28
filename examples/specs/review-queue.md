---
graft: 1
id: review-queue
host: wordpress
mount:
  slot: admin.page
  menu:
    parent: posts
    title: Review queue
audience: [editor, contributor]
permissions:
  - posts:read
  - posts.status:write
---

# Review queue for editors

Editors see only posts that need review, with title, author and submission
date, and can approve with one click.

## Acceptance criteria

- Only posts with status "pending" are listed {#pending-only}
- Columns: title, author, submitted date {#columns}
- "Approve" sets status to "publish" and removes the row {#approve}
- Contributors cannot see the approve button {#contributors-no-approve}
- When nothing is pending, the page says "Nothing to review" {#empty-state}

## Out of scope

- Rejecting posts or leaving feedback
- Scheduling instead of publishing
