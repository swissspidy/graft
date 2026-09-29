---
graft: 1
id: headline-check
host: wordpress
mount:
  slot: dashboard.widget
  title: Headline check
audience: [editor, administrator]
permissions:
  - posts:read
---

# Headline check

Editors see on their Dashboard what is wrong, if anything, with the
headline of each post waiting for review, before they open it.

## Acceptance criteria

- Lists pending posts only {#pending-only}
- Headlines longer than 70 characters are "Too long" {#too-long}
- Headlines in capitals are "All caps" {#all-caps}
- Headlines of fewer than three words are "Too short" {#too-short}
- Every problem is listed, marked as a warning {#warning}
- Other headlines "Look good", marked as fine {#good}

## Out of scope

- Editing headlines from the Dashboard
