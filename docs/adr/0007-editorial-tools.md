# ADR 0007: Inputs, the block editor, and editing post fields

- Status: Accepted (WordPress)
- Date: 2026-09-30
- Builds on: [ADR 0006](0006-interactive-widgets.md)

## Context

Widgets (ADR 0006) keep state and offer the actions their build declares,
but the viewer can only click. Many editorial tools need the viewer to
type, for example to fix a headline, write an excerpt, or tick a manual
check. Such tools also belong next to the post being edited, not on a
separate page or on the Dashboard. The WordPress surface had neither
inputs nor a place in the block editor, and no capability that changes
anything but a post's status.

## Decision

### Inputs are components that the host keeps the value of

The WordPress surface adds four components that widgets can draw with:
`text-input`, `textarea`, `checkbox` and `select`. The surface lists them
under `functions.widgets.inputs`, so the core knows which components are
inputs without knowing the host.

- An input has an `id` and a `label`. Its `value` is what it *starts*
  with. After that, it shows what the viewer entered, and the code cannot
  change it: a redraw with another `value` does not replace what the
  viewer typed.
- With `onChange: {"$event": name}`, every change goes to `update` with
  the entered value as the payload. The code can then react as the viewer
  types, for example by re-evaluating a checklist.
- A widget's declared actions read inputs with `{"$input": id}` in their
  `call` input. The host evaluates it from what the input shows, so **an
  action sends what is on screen, never a value the code keeps out of
  sight**. The code can pre-fill a field, but the viewer sees what will be
  sent.
- `$input` is valid only in a widget's declared actions
  (`props.actions.<name>.call.input`). Validation refuses it anywhere else,
  including a declared action's `visible` condition, so it only ever
  becomes capability input. Code cannot produce it either: the sanitizer
  turns objects with `$` keys into null.
- Inputs outside a widget render nothing: they have no value to show.

The trust model of ADR 0006 is unchanged. The viewer is the one typing,
the gateway validates each input against the capability's schema, and it
checks the grant and the viewer's permissions as before.

### A slot in the block editor

`post.editor.panel` is an extension slot. It is a panel in the editor's
document sidebar (`PluginDocumentSettingPanel`), for saved posts the
viewer can edit. It provides `{"post": {id, title, excerpt, status, type,
can}}`, with the title and excerpt as saved, unformatted.

The editor keeps its own copy of the post, which raises two problems:

- **Stale copy.** After an action changes the post, the editor's copy is
  out of date, and saving it would undo the change. Actions in this slot
  end with `reload:page`, which reloads the editor.
- **Unsaved changes.** If the editor has unsaved changes, a reload would
  lose them, and the next save would overwrite the action's change. The
  runtime therefore refuses calls from the panel while the editor has
  unsaved changes ("Save or discard your changes to the post first").
  Reads are exempt: the plugin lists the surface's read capabilities in
  the editor config, so data sources still load.

A new, unsaved post gets no panel. Reloading `post-new.php` would open a
different post than the one an action changed.

The runtime does not bundle the editor packages. It reads `wp.plugins`,
`wp.editor` and `wp.data` from the page, and adds them as script
dependencies only on the editor screen.

### Editing a post's title and excerpt

`posts.update_fields` (ability `graft/post-update-fields`) changes the
title, the excerpt, or both, as plain text. The post's content, status
and all other fields stay as they are. A field sent back exactly as it
is stored is left alone, so saving a new title does not strip markup
from an excerpt nobody edited. It needs a new scope,
`posts:write` ("Change the title and excerpt of posts you can edit",
which requires `edit_posts`). The ability also checks `edit_post` on the
post itself, and `$can: "posts:write"` uses the post's own `can.edit`.

### Verifying inputs

Checks gain a step, `{"fill": id, "value": ...}`, which types into an
input. The verifier records what the viewer entered per widget. It sends
the change event to `update`, and declared actions read the same values
through `$input`, as in the browser. A new expectation, `{"input": id,
"value": ...}`, checks what an input shows. The sandbox seeds posts with
an optional `excerpt`, and the `post` assertion compares it.

## Example

`examples/specs/publish-checklist.md` is a panel in the editor with:

- the headline and excerpt as fields, starting from what is saved;
- a checklist that follows typing (headline length, capitals, excerpt
  length);
- a "Facts and names checked" box the writer ticks;
- "Save" (`posts.update_fields` with `$input`);
- "Publish", which the code offers only when everything is ticked and
  saved, and which the build shows only to people who may publish.

It is verified in Playground (13 checks), tested in the real block editor
(e2e), and installed in the Playground demo.

## Consequences

- Widgets can now build forms. Declared actions still decide what is
  written, and the viewer still decides the values.
- Input state lasts one page view, like widget state. The editor slot
  reloads after each change, so the checkbox starts unticked again.
- Writes from the editor panel need a saved editor. This is stricter than
  necessary: a change to the excerpt could merge with unsaved block
  edits. It is simple, and it never loses anyone's work.
- EmDash does not get inputs yet. Its Block Kit has input elements, but a
  mapping (and the states they need across server renders) is its own
  step.
- Surface 7.1 changes (new slot, scope, capability and components), so
  every WordPress build is re-pointed. Nothing that existing builds use
  changed.
