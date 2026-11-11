# ADR 0013: Seeing what happened, and getting back

- Status: Accepted (WordPress; locked areas and local state also on the
  browser and EmDash hosts)
- Date: 2026-11-11
- Builds on: [ADR 0002](0002-authoring-and-operations.md),
  [ADR 0008](0008-agency-sites.md), [ADR 0011](0011-browser-extension-host.md)

## Context

A read of the whole code base ([the audit](../audit-2026-11.md)) compared
Graft with [Extensible Web Apps](https://extensibleweb.app/), a kernel in
the browser where every feature is a plugin people add and remove while
the app runs. Its plugins are code and Graft's builds are not, and it has
no answer to a host that changes, which is what Graft is for. But three
things it gives the person operating it, Graft did not:

- a way back that needs nothing to work (`?reset` puts an app's plugins
  back as its author shipped them, before any of them runs);
- a record of every change, and a trace that says why something did not
  happen;
- areas of a page its author marks as off limits, enforced by the
  platform.

It also lets anyone change the app for themselves, where Graft only let
administrators change it for everyone, and it never trusts a view with
state the host did not track.

## Decision

### Safe mode

`define( 'GRAFT_SAFE_MODE', true )` (or the `graft_safe_mode` filter)
serves no customization and runs no trigger. Tools → Customizations is
Graft's own screen, not a build, so it still works: it says safe mode is
on, and the customization that caused trouble can be archived there.
`GRAFT_DISABLE_TRIGGERS` stays, for sites that want views and no
automation.

### One reason for not showing

`not_served_reason()` is the only place that decides whether a version is
served: safe mode, not active, no surface, no build for this surface, a
build that did not pass its checks, a grant that does not cover it.
`servable_specs()` and `trigger_specs()` serve what it returns null for,
and the list of customizations carries its answer (`not_served`), so the
screen says "Not showing" with the same reason the runtime acted on.
Before, an active customization with no build for the site as it is now
looked the same as one that works.

### A change log

Every version created, every build attached (for which surface, verified
or not, by which runner) and every lifecycle event is appended to
`graft_change_log` with the time and the user; an approval records the
scopes it granted, to viewers and to each trigger, as they stood then.
The latest 500 are kept, `GET graft/v1/changes` returns them newest
first to administrators, the screen shows them under **History**, and
`graft_change_recorded` fires for a log that should outlive this one.
The gateway's refusals (`graft/v1/audit`) and trigger runs keep their own
logs: those are what customizations did, this is what people did to them.

### Managed builds are carried over, not replaced

ADR 0008 let a site attach a build to a managed customization so that an
upgrade on the site could carry it over, and said its builds could not be
replaced from wp-admin; the route did not tell the two apart. Now it
does: for a managed customization, a build for a surface it has no build
for is accepted, and one for a surface it has a build for is refused
(`graft_managed`). What the maintainer shipped is only changed by the
maintainer.

### The spec is stored as written

A version's source is kept in its own meta (`_graft_source`). The post
content it used to be read from goes through WordPress's HTML filter for
users without `unfiltered_html`, so `<` in a criterion came back as
`&lt;` under a hash of the original. Versions stored before this are read
from the post content, as before. PHP also trims the same trailing
whitespace as JavaScript when hashing, so a line ending in a no-break
space no longer gives two hashes.

### Locked areas (browser host)

An app description may list `locked` selectors: areas nothing is ever
drawn in. A slot's anchor is declared outside them, but the app can move
it there, and re-anchoring by landmark looks anywhere on the page. An
anchor that resolves inside a locked area is `broken`, never `moved`:
the content script draws nothing and the drift probe proposes no
selector. `before` and `after` change the anchor's parent, so the
parent's area counts; `append` and `prepend` change the anchor itself.
The list is part of every anchor, so of the surface's hash.

There is no "ask first" area yet. On this host everything is approved
before it is installed; a second approval at the moment of drawing has no
one to ask on a page the extension does not own.

### Local state is only what the build can set

EmDash and the browser host keep a build's local state outside the host
(in a button's value, in the page). The walker already refuses to let it
replace loaded data. Now both hosts also drop every key that is not the
target of one of the build's own `set` actions (`localState()` in
`@swissspidy/graft-a2ui`) before drawing. Keeping the state on the server
was considered: on EmDash it would mean a write to the plugin's store on
every click and state that outlives the page, for no more than this
gives.

### Customizations for one person

The store, the gateway and the runtime have had `scope: user` since ADR
0002; no screen offered it. **New customization** now has "Only for me":
the customization is shown to its author alone, as one of the roles its
audience names, and the list marks it. It is still compiled, verified and approved
like any other. An administrator can live with a customization before
giving it to a whole role.

## Decided since

People who are not administrators writing their own was left open here.
[ADR 0014](0014-customizations-of-ones-own.md) decides it: the site pays
for the compile within a daily limit, a read-only customization of one's
own goes live without an administrator, and both sides see it on the same
screen under Tools.

## Consequences

- The reason a customization does not show is one function, read by the
  runtime and the screen. A new reason is added there.
- The change log is an option of at most 500 entries, written on every
  change. Sites that need more hook `graft_change_recorded`.
- An app description that adds `locked` changes its surface's hash, and
  its builds are re-stamped or upgraded as for any other surface change.
- A build cannot keep local state under a pointer no `set` targets.
  Inputs do not exist on the two hosts this applies to.
