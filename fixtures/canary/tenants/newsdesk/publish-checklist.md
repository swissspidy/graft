---
graft: 1
id: publish-checklist
host: wordpress
mount:
  slot: post.editor.panel
  title: Publish checklist
audience: [contributor, author, editor, administrator]
permissions:
  - posts:write
  - posts.status:write
---

# Publish checklist

Next to the post they are editing, writers see whether it is ready to go
out: a headline that fits search results, not shouted in capitals, and an
excerpt to show in search results and on social media, and that they
checked facts and names themselves. They fix the headline and excerpt
right there, and the checklist follows as they type.
Once everything is ticked and saved, people who may publish get a Publish
button.

## Acceptance criteria

- The headline and excerpt fields start with the post's saved headline and excerpt {#prefilled}
- The checklist says whether the headline is 20 to 70 characters, whether it is not in capitals, and whether there is an excerpt of at least 50 characters, with a tick or a cross, and the current length where it falls short {#checklist}
- The writer ticks "Facts and names checked" themselves; it starts unticked {#facts}
- The checklist follows what the writer types, before anything is saved {#live}
- "Save" saves the headline and excerpt as typed {#save}
- "Publish" is offered once every item is ticked and the changes are saved, and publishes the post {#publish}
- Contributors can save, but never get "Publish" {#contributors}

## Out of scope

- Checking the post's content
- Scheduling
