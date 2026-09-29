---
graft: 1
id: stale-drafts
host: emdash
mount:
  slot: dashboard.widget
  title: Stale drafts
audience: [editor, admin]
permissions:
  - content:read
---

# Stale drafts

Editors see on the dashboard which drafts nobody has touched for a while,
so they can chase them up or throw them away.

## Acceptance criteria

- Lists draft posts only {#drafts-only}
- Shows how many days ago each draft was last updated {#days}
- Drafts untouched for a week are marked as a warning, and for a month as
  an error; fresher ones are fine {#age-tone}
