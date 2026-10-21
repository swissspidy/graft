---
graft: 1
id: my-tasks
host: browser
mount:
  slot: project.sidebar
  title: My open tasks
permissions:
  - tasks:read
  - tasks.status:write
---

# My open tasks

In the sidebar of a Tasklet project, people see the open tasks of that
project assigned to them, with overdue ones marked, and members can mark
one done without leaving the page.

## Acceptance criteria

- Lists only open tasks assigned to me {#mine-open}
- Lists only tasks of the project being viewed {#this-project}
- Columns: Task, Due {#columns}
- Overdue tasks are marked as errors {#overdue}
- "Done" marks the task done and removes it from the list {#done}
- Guests do not get the "Done" button {#guests-no-done}
- When nothing is open, it says "Nothing on your plate" {#empty}

## Out of scope

- Reassigning tasks or changing due dates
