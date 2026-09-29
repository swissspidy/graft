---
graft: 1
id: waiting-posts
host: wordpress
mount:
  slot: dashboard.widget
  title: Waiting for review
audience: [editor, administrator]
permissions:
  - posts:read
---

# Waiting for review

Editors see on their Dashboard which posts are waiting for review, newest
first, without leaving the Dashboard.

## Acceptance criteria

- Lists pending posts only, with title and author {#pending-only}
- Shows at most five posts {#at-most-five}
- When nothing is pending, it says "Nothing is waiting" {#empty}

## Out of scope

- Approving from the Dashboard
