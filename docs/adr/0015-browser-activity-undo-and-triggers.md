# ADR 0015: Activity, undo and triggers in the browser extension, and the browser as a surface

- Status: Proposed (prototype in `hosts/chrome-extension`)
- Date: 2026-11-19
- Builds on: [ADR 0010](0010-scheduled-actions.md), [ADR 0011](0011-browser-extension-host.md), [ADR 0013](0013-operating-and-recovering.md)

## Context

Paul Kinlan's ["my chrome extensions are just prompts"](https://aifoc.us/my-chrome-extensions-are-just-prompts/)
describes extensions that are agents. Each one is a `prompt.md`, a
manifest and a generic runtime. The runtime exposes about fifty
`chrome.*` APIs as tools, hides the tools whose permission is not
granted, and wakes on alarms, browser events and clicks. Every run keeps
an audit log, a trace and an undo journal.

Its model is the opposite of Graft's. The model runs on every wake, so
the extension runs code it did not ship. It cannot be in the Chrome Web
Store, and page text reaches the model, which the post calls "a
mitigation and not a solution". Graft compiles a spec once, verifies the
build against frozen checks and ships data, so neither problem applies.

The post has four things the browser host of ADR 0011 lacked:

1. A record of what customizations did, shown to the person.
2. A way to put back what they changed.
3. Running on their own, without a page open.
4. The browser itself as something to customize, not only apps in it.

## Decision

### The gateway reports every call it refuses or makes

The gateway (`gateway.ts`) now takes how a call runs (`Perform`: a
request to the app, or a tab function) and reports each call through
`onCall`. It reports one of three outcomes:

- `ok`: the call went through.
- `refused`: the gateway stopped it.
- `failed`: the host refused it, or it broke.

Refusals keep their codes (`graft_not_granted`, ...). The service worker
turns reports into the **activity log** (`activity.ts`), kept in
`chrome.storage.local`, latest 200. The log records:

- every write;
- every refusal;
- every failed call, drift included.

Reads that went through are not recorded. Every page view makes them,
and the options page already says what each customization may read.
Each entry says when it happened and which customization made it. It
also says who made it: "by you" through a view, "on its own" by a
trigger, or "undone by you". The options page shows the log under
**Activity**, newest first.

This is the browser's counterpart of ADR 0013's change log and the
gateway's audit log on WordPress. Those record what people did to
customizations; this records what customizations did.

### Undo is declared by the surface, next to the binding

A write capability's binding may say how to put back what it did:

```ts
binding: {
	method: 'POST',
	path: '/api/tasks/{id}/complete',
	undo: { capability: 'tasks.reopen', input: { id: { input: 'id' } } },
}
```

The reverse is another write of the same surface. Each of its input
fields comes from the original's input (`{ input }`) or from its answer
(`{ output: <JSON Pointer> }`).

The adapter author declares it, so it is part of the surface and its
hash. It is data, and no build can declare or change it.
`undoProblems()` checks three rules when the surface is built, and a
description that breaks one does not build:

- The reverse is a write.
- The reverse needs no scope the original does not.
- The reverse takes every field the undo sets.

When a write goes through, its log entry keeps the reverse call,
computed from that call's input and answer. **Undo** on the options page
runs it once, under these conditions:

- It runs on the surface the call was made on, by hash.
- For an app, it goes to the origin the call went to, with the person's
  session.
- It goes through the same checks: the reverse's scopes, its input
  schema, the app's own permission check.

It does not need the customization's current grant. Revoking a
customization that misbehaved and then undoing what it did has to work.
The reverse can do no more than the original, which was approved when
it was made. The undo is logged too.

Tasklet's `tasks.complete` undoes with a new `tasks.reopen`. The
browser's `tabs.close` answers with the closed tab, and undoes with
`tabs.open` on its address. That opens a new tab, not the old one: its
history and form state are gone. `chrome.sessions` could restore the
old tab, at the cost of the `sessions` permission.

Undo puts back what the call changed, in the way the app's reverse does
it. It does not check what happened since. If someone completed and
reopened the task meanwhile, undo reopens it anyway, as the app would
for anyone who asked.

### The browser as a surface (`host: chrome`)

The browser itself is a second surface in the same extension
(`src/browser`). It is its own host, not another app on the `browser`
host, because it has none of an app's parts: no origin, no anchors, no
session and no drift. Specs for it say `host: chrome`.

| | An app (`host: browser`) | The browser (`host: chrome`) |
| --- | --- | --- |
| Surface | Described from the outside, kept honest by probing | Generated from the extension's code (`pnpm surface:extension`), like WordPress's |
| Version | The observed fingerprint | The oldest Chrome it describes (`121`, for `tab.lastAccessed`) |
| Slots | Anchors in the app's pages | `side-panel`, the extension's side panel (owned) |
| Capabilities | HTTP bindings to the app's API | `tabs.list`, `tabs.close`, `tabs.open`, `tabs.focus` over `chrome.tabs` |
| Scopes map to | App roles | Chrome permissions (`model.permissions`), which the manifest asks for |
| Audiences | App roles | None: a profile has one person |
| Verification | A copy of the app | An in-memory browser running the same tab functions |

The tab functions (`tabs.ts`) run in both the extension and the sandbox.
They filter (`pinned`, `unusedForDays`), sort least recently used first,
and cut answers down to the declared output, as an app's answers are.
`tabs.open` opens web pages only (`http`, `https`). The schema says so,
and the function checks again, because it is the one place an address
leaves the extension. The side panel draws with the same view code as
the content script (`view.ts`) and redraws when tabs change.

The manifest gains `tabs`, `sidePanel`, `alarms`, a `side_panel` page and
a toolbar button that opens it. All of them come from the surfaces it
ships.

### Triggers run in the service worker

The browser surface declares `triggers` (ADR 0010):

- schedules at least an hour apart;
- at most 20 calls a run;
- `tabs.list` and `tabs.close` allowed;
- no events yet.

A spec declares its triggers and their permissions as on WordPress.
Approving it grants the viewer scopes and, apart, each trigger's
(`triggerGrants`).

A browser profile has no other identity than its person, so a trigger
acts with the extension's access. What keeps "what was approved" and
"what can happen" the same set is the per-trigger grant, enforced by the
same checks as on WordPress, in `runner.ts`:

1. The trigger uses the capability.
2. The surface lets triggers use it.
3. The trigger's grant covers its scopes.
4. The input matches.

The runner is core's `runTrigger()`. The options page names who it runs
as.

- **When.** `chrome.alarms` wakes the service worker every 15 minutes,
  and it starts the triggers that are due. A new trigger waits for its
  first slot after approval. Days `at` a time use the browser's time
  zone. A browser that was closed at that time runs at the next wake.
- **Bounds.** ADR 0010's: the per-run cap, three failed runs in a row
  pause the trigger with the reason, and a dry run changes nothing.
- **Stopping.** On the options page, under **Runs on its own**: pause
  and resume a trigger, dry run, run now. **Pause all** stops every
  trigger.
- **Record.** The latest 100 runs are kept and shown in words ("Ran on
  schedule: acted on 1 of 1 (Old)"). Each call they made is in the
  activity log, with its undo.
- **Clock.** A run's tab functions count "unused for more than N days"
  to the run's clock. The tests run a trigger "a week later" without
  waiting a week. Checks fire triggers at the check's clock, as on
  WordPress.

App surfaces declare no triggers yet. An unattended call to a
third-party app has three problems:

- It needs an origin, and the app's origins are match patterns.
- It needs a session that may have expired.
- It writes to someone's account in a SaaS app with nobody looking,
  where drift is only noticed on page views.

The runner is not specific to tabs, so an app surface could declare
triggers once those have answers.

### The example

[`examples/browser`](../../examples/browser/README.md): "Stale tabs"
lists tabs unused for more than a week in the side panel, with **Close**.
Once a day it closes up to ten of them on its own, never pinned ones. Its
nine checks were written from the criteria first. They pass in the
in-memory browser.

Each of these wrong builds fails exactly the check for its criterion:

- a trigger that also closes pinned tabs;
- a trigger with a one-day threshold;
- a list with a six-day threshold;
- Close without removing the row.

The build was written by hand, as the board's was. No model key was at
hand when it was written, and the checks were written first.

## Consequences

- The person can see what every customization did and was refused, and
  put back what can be put back, without the customization's help.
- Tasklet's surface gained `tasks.reopen`, so its hash changed. The
  example's build was re-stamped (its spec did not change),
  re-verified and re-bundled. The scope "Mark tasks done" now reads
  "Mark tasks done, or open them again", because it covers both.
- The extension asks for `tabs` at install, so Chrome warns about
  reading browsing history before anything is approved. Optional
  permissions requested on approval would be better. Playwright cannot
  answer Chrome's permission prompt, so this is left for later.
- Undo depends on the app having a reverse, and on the adapter author
  declaring it. Writes without one are logged without Undo.
- The activity log and run records are local to the profile and
  unsigned, like ADR 0010's run log.
- Not done yet:
  - event triggers (`tabs.onCreated`, `tabs.onUpdated`);
  - more of the browser (tab groups, bookmarks, history), each a set of
    capabilities and permissions;
  - triggers for app surfaces;
  - restoring a closed tab with `chrome.sessions`.

## Alternatives considered

- **An agent that runs at every wake** (the post's design). It is
  flexible, but it runs generated code, lets page text steer it, and
  gives no repeatable result to check. Graft's builds are verified once
  and do the same thing every time. The post's own `saveAs` scripts move
  part of the way toward that.
- **Undo by snapshot:** read the state before each write and restore it
  with a generic setter. Every write would need a read first, and a
  setter the app may not have. A reverse the adapter author declares is
  explicit, and the surface checks it.
- **Undo that needs the current grant.** Revoking a customization would
  then strand what it did.
- **Logging every read.** Every page view would push the writes out of
  the log.
- **The browser as an app on the `browser` host.** It has no origin,
  anchors, roles or drift. Every piece of the app model would be empty
  or faked.
