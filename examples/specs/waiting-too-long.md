---
graft: 1
id: waiting-too-long
host: wordpress
mount:
  slot: dashboard.widget
  title: Waiting too long
audience: [editor, administrator]
permissions:
  - posts:read
triggers:
  flag-stale:
    schedule: { every: 1d, at: "09:00" }
    permissions: [posts:read, posts.terms:write]
    limit: 20
  clear-on-publish:
    event: post.published
    permissions: [posts.terms:write]
---

# Waiting too long

Every morning, posts that have waited in review for more than a week get
the "Waiting too long" tag, so they stand out in the review queue and on
the editors' Dashboard. Publishing a post takes the tag off again.

## Acceptance criteria

- Every morning, pending posts untouched for more than 7 days get the tag "waiting-too-long" {#flag-stale}
- Pending posts untouched for 7 days or less, drafts and published posts are left alone {#leave-others}
- A post is tagged once, even when it is still waiting the next morning {#once}
- At most 20 posts are tagged per morning; the rest wait for the next one {#cap}
- When a tagged post is published, the tag comes off {#clear-on-publish}
- Editors see the tagged pending posts on their Dashboard, oldest first, with how many days each has waited {#widget}
- When nothing waits too long, the widget says "Nothing is waiting too long" {#empty}

## Out of scope

- Emailing or otherwise notifying anyone
- Creating the tag: it must exist on the site

## Notes

The tag is the site's own "waiting-too-long" post tag. Tagging and
untagging do not change when a post was last modified.
