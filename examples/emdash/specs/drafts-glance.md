---
graft: 1
id: drafts-glance
host: emdash
mount:
  slot: dashboard.widget
  title: Drafts
audience: [editor, admin]
permissions:
  - content:read
---

# Drafts at a glance

Editors see on the dashboard which posts are still drafts, most recently
updated first.

## Acceptance criteria

- Lists draft posts only, by title {#drafts-only}
- Shows at most five posts {#at-most-five}
- When there are no drafts, it says "No drafts" {#empty}
