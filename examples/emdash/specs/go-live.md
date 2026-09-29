---
graft: 1
id: go-live
host: emdash
mount:
  slot: content.editor.panel
  collections: [posts]
audience: [editor, admin]
permissions:
  - content:read
  - content.status:write
---

# Go live from the editor

In the post editor, editors see at a glance whether the post is live, and
can put it live or take it offline from the sidebar.

## Acceptance criteria

- Published posts show "Live", drafts show "Not live" {#state}
- "Go live" publishes a draft {#go-live}
- "Take offline" turns a published post back into a draft {#take-offline}
