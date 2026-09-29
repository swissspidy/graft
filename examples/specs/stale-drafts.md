---
graft: 1
id: stale-drafts
host: wordpress
mount:
  slot: dashboard.widget
  title: Stale drafts
audience: [editor, administrator]
permissions:
  - posts:read
---

# Stale drafts

Editors see on their Dashboard which drafts nobody has touched for a
while, so they can chase them up or throw them away.

## Acceptance criteria

- Lists drafts only {#drafts-only}
- Shows how many days ago each draft was last updated {#days}
- Drafts untouched for a week are marked as a warning, and for a month as
  an error; fresher ones are fine {#age-tone}

## Out of scope

- Deleting or reassigning drafts from the Dashboard
