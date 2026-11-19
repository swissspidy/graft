---
graft: 1
id: stale-tabs
host: chrome
mount:
  slot: side-panel
  title: Stale tabs
permissions:
  - tabs:read
  - tabs:write
triggers:
  close-stale:
    schedule: { every: 1d }
    permissions: [tabs:read, tabs:write]
    limit: 10
---

# Stale tabs

The side panel lists the tabs I have not looked at for more than a week,
so I can close them, and once a day the extension closes some of them on
its own. Pinned tabs are left alone. Every tab it closes can be opened
again from the extension's activity log.

## Acceptance criteria

- Lists only tabs not used for more than 7 days {#stale-only}
- Pinned tabs are never listed {#pinned-hidden}
- Columns: Tab, Last used {#columns}
- "Last used" says how many days ago, e.g. "10 days ago" {#last-used}
- "Close" closes the tab and removes it from the list {#close}
- Once a day, tabs not used for more than 7 days are closed on their own {#daily}
- Pinned tabs are never closed on their own {#pinned-kept}
- At most 10 tabs are closed on their own in a day {#limit}
- When no tab is stale, it says "No stale tabs" {#empty}

## Out of scope

- Grouping, moving or bookmarking tabs
- Tabs in other browser profiles
