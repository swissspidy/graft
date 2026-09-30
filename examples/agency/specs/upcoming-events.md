---
graft: 1
id: upcoming-events
host: wordpress
mount:
  slot: dashboard.widget
  title: Upcoming events
audience: [editor, administrator]
permissions:
  - posts:read
  - posts.meta:write
---

# Upcoming events

The box office team sees the events on the Dashboard, soonest first, with
where they take place and how many seats they have, and marks an event
sold out without opening it.

## Acceptance criteria

- Lists events only, not posts or pages, soonest first {#events-soonest-first}
- Shows each event's date, venue and seats {#details}
- An event without a venue says so, as an error {#missing-venue}
- Marking an event sold out saves it, and the event no longer offers it {#sold-out}

## Out of scope

- Editing dates, venues or seats from the Dashboard
