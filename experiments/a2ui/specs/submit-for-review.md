---
graft: 1
id: submit-for-review
host: wordpress
mount:
  slot: dashboard.widget
  title: Submit for review
audience: [contributor, author, editor]
permissions:
  - posts:read
  - posts.status:write
---

# Submit a draft for review

Writers send one of their drafts to the editors in two steps, so nothing
goes out by accident: first they pick a draft, then they see what they
picked and confirm, or go back and pick another one.

## Acceptance criteria

- First, the widget lists the viewer's drafts, each with a "Choose" button, and nothing else to do {#pick}
- Choosing a draft shows a confirmation step instead of the list: "Send “<title>” for review?" with "Send" and "Back" {#confirm}
- "Back" returns to the list of drafts, with nothing sent {#back}
- "Send" sets the chosen draft to pending, and the widget then says "Sent “<title>” for review." {#send}
- Posts that are not drafts are never listed {#drafts-only}

## Out of scope

- Editing the draft
- Picking more than one draft
