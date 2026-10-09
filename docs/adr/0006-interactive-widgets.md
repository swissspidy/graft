# ADR 0006: Interactive widgets drawn by sandboxed code

- Status: Superseded by [ADR 0009](0009-a2ui.md): A2UI's catalog functions and local state replaced
  functions and widgets, and both were removed
- Date: 2026-09-29
- Builds on: [ADR 0005](0005-sandboxed-functions.md)

## Context

ADR 0005 let a build compute values with pure functions in a QuickJS
sandbox. A build still could not keep state: nothing in a build changes
as the viewer clicks. Filtering a list, switching between views or
stepping through items all need state, and the expression language has
none on purpose.

The constraint from ADR 0005 stays. Code never touches the page, never
calls a capability and never decides what is read or written.

## Decision

### A widget is two functions: render and update

A build adds a `widget` node naming two of its functions:

```json
{ "type": "widget", "props": { "render": "draw", "update": "choose", "input": { "$data": "pending.items" }, "state": { "author": null } } }
```

- `render(input, state)` returns a tree of nodes (`{type, props,
  children}`) made of the host's own components.
- `update(state, event, payload, input)` returns the next state.
- `input` is evaluated like any prop; it is how data reaches the code.
- `state` is the initial state, as plain data.

A button in the drawn tree sends an event instead of calling a
capability: `onClick: {"$event": "choose", "payload": {"author": "Ada"}}`.
Using it calls `update`, then `render` again with the new state.

This is the Elm architecture. It suits a sandbox well:
- Both functions are pure, so results can be cached by their arguments.
- They run in the ADR 0005 runtime unchanged: batched calls to the
  worker, and the same limits.

### The host draws, the code only describes

What `render` returns is data, never markup. `sanitizeWidgetTree` in the
core turns it into a tree the host may draw:

- **Only allow-listed components.** The surface lists what widgets may
  draw with (`functions.widgets.components`). WordPress allows `stack`,
  `heading`, `text`, `button`, `notice`, `card`, `empty-state` and
  `table`: display components, plus buttons. Not `row-action`, not
  another `widget`, and nothing unknown.
- **Props are inert data.** As with `$fn` results, objects with `$` keys
  become null, so code cannot produce a `$call`, a binding or a `$fn`.
  The only live values left are event markers, and their names must be
  plain identifiers.
- **Limits.** At most `maxNodes` nodes per render (200 on WordPress), and
  at most 20 levels deep.

The host's own React components then draw that tree, as they draw a
build's. Inside a widget the runtime's `invoke` only accepts the widget's
events, so even a button that somehow kept an action would do nothing.

### Verification sees what the viewer sees

The verifier draws widgets with the same sanitizer, running the code in
QuickJS in-process as in ADR 0005.

- **Validation.** It checks each drawn tree against the surface's
  component schemas, as it checks a build's tree. Event markers stand
  where actions go. A widget that draws something invalid fails the
  check, with the node path in the message.
- **Snapshots.** A widget's event buttons appear as actions carrying the
  event. A button whose `onClick` was a `$call` appears but is
  unavailable, and verification reports it as invalid.
- **Steps click widget buttons.** `{"action": "author-bob"}` runs
  `update` and draws the widget again. Widget state lives with its slot
  instance: it survives `refresh`, and `reload:page` resets it, as in the
  browser.

### Declared actions: code picks the row, the build says what happens

A widget can change things, but only through actions its build declares:

```json
"actions": { "approve": { "call": { "$call": "posts.update_status", "input": { "id": { "$field": "id" }, "status": "publish" }, "then": ["refresh:pending"] }, "visible": { "$can": "posts.status:write" } } }
```

A drawn button offers one with `onClick: {"$use": "approve", "row": <id>}`.
In a table's row actions, `{"$use": "approve"}` applies to that row. The
host resolves the use while drawing (`resolveWidgetUse`):

- **Declared actions only.** The action must be declared on the widget
  node. A name it does not declare is refused.
- **Real rows only.** The row must be one of the widget's `input` rows,
  matched by `id`. A copy the code made, with forged fields, still
  resolves to the input's own row, and an id that is not there resolves
  to nothing.
- **The build decides what happens.** The declared `$call` is evaluated
  for that row, as table actions are, and offered only where `visible`
  holds. What reaches the component is either that action or null. The
  WordPress components hide a button whose action is null.
- **The usual gates still apply.** Invoking the action goes through the
  normal gateway: the build must use the capability, the grant must cover
  it, and the host's own permission check runs.

Code decides which declared action to offer on which of the rows it was
given. It never decides the capability, the input or the permission.
The verifier resolves uses the same way. A use of an undeclared action,
or on a row that is not in the input, fails the check with a reason.

### Lifecycle

- **Validation.** Only surfaces with `functions.widgets` accept a
  `widget` node, and `render` and `update` must name the build's
  functions.
- **Compiler.** The prompt explains widgets when the surface runs them:
  when to use one, the render and update contract, the allowed
  components, and how checks click buttons.
- **Upgrades.** The static check notices a host that stops running
  widgets and starts regeneration ("the host no longer runs interactive
  widgets"). The canary has a `no-widgets` scenario.

## Example

`examples/specs/pending-by-author.md` lists pending posts with a button
per author ("Ada (2)"). Choosing an author lists only that author's
posts, and "Everyone" lists all of them again. Each row has an Approve
button, the widget's declared `approve` action, offered where the viewer
may publish that post. Its checks click the buttons and approve a post.
It passes in Playground, is served in wp-admin (e2e: the buttons switch
the list, and Approve publishes through the gateway), and is in the canary
corpus.

## Consequences

- **Actions need an input list with ids.** A widget without `input` rows
  (records with an `id`) cannot offer declared actions. That covers lists
  of records, the common case; actions on other shapes would need another
  way to name what they apply to.
- **State is per page view.** Nothing is persisted; a reload starts from
  the initial state.
- **One worker per build with code.** Two widgets on one screen from two
  customizations start two workers; one build's code never shares a
  realm with another's.
- **EmDash.** EmDash draws widgets on the server: the plugin runs
  `render`, sanitizes the tree and translates it to Block Kit like the
  build's own tree, with the same Block Kit components as the allow-list.
  The admin keeps no state for a plugin, so every button of a
  customization with widgets carries the widgets' states in its value. A
  click re-renders with those states, finds the button again in that
  render and, for an event, runs `update` for the next state; the event's
  payload comes from that render, never from the browser. The viewer can
  forge a state, which only changes what the code draws: a declared
  action still resolves against the rows the server loaded, is offered
  only where `visible` holds, and passes the gateway. State lasts as long
  as the view: a reload, or opening another tab, starts over.
- **Components stay trusted.** Arrow's sandbox, mentioned in ADR 0005,
  renders templates to the DOM through a bridge. This design never
  renders code's markup: code describes, the host's components draw. It
  is less expressive, but it stays inside the component vocabulary that
  checks, surfaces and upgrades already understand.
