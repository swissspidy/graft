---
graft: 1
id: family-friendly
host: wordpress
mount:
  slot: posts.list.row-actions
  post_type: event
audience: [author, editor, administrator]
permissions:
  - posts.terms:write
---

# Family friendly

On the Events screen, whoever looks after an event can mark it as family
friendly in one click, for the families page of the programme.

## Acceptance criteria

- Events that are not family friendly yet offer "Family friendly" {#offered}
- Using it adds the Family type and keeps the event's other types {#adds}
- Events that are already family friendly do not offer it {#not-twice}
- It is only on the Events screen, not on posts {#events-only}
- People who cannot edit an event do not get it {#editors-only}

## Out of scope

- Removing the Family type
