# ADR 0014: Customizations people write for themselves

- Status: Accepted (WordPress)
- Date: 2026-11-11
- Builds on: [ADR 0002](0002-authoring-and-operations.md),
  [ADR 0013](0013-operating-and-recovering.md)

## Context

Graft says it is for people who do not write code. Until now only
administrators could write a customization, and always for a whole
audience. The store has accepted a personal spec (`scope: user`) from
anyone who can edit posts since ADR 0002, and nothing let them build one.
ADR 0013 left three questions open; they are answered here.

## Decision

Anyone who can edit posts has **Tools → Customizations**. Administrators
see the site's customizations there, as before. Everyone else sees the
ones they wrote for themselves, and can write a new one.

### Who pays for the compile

The site. The compiler runs in the author's browser and its model
requests go through `POST graft/v1/generate`, answered by the AI provider
set up in the site's settings, as for administrators. People who are not
administrators may make 30 such requests a day each (a compile makes two
to six); `graft_personal_generate_limit` changes the number. A site
without a provider compiles for nobody.

### What goes live without an administrator

A customization that is its author's alone, has no triggers, and asks, in
its spec and in its build, for nothing but scopes that only read
(`self_service_scopes()`: the surface's `:read` scopes the policy allows;
`graft_self_service_scopes` narrows or empties the list). It is approved
in its author's name the moment a verified build is attached, and the
change log says so.

Anything else a person writes for themselves waits for an administrator,
who sees it in the list marked "Only for <name>", with its checks, and
approves or declines it like any other.

This is safe for the same reason the gateway is: every call a build makes
runs as the viewer, behind the ability's own permission check. A
customization only its author sees, that only reads, shows them what they
could already see. The verification record of such a build comes from the
author's own browser, so it proves nothing to anyone else: it is stored
with `runner: author`, and it is never served to another person.

A personal customization is shown to its owner whatever audience its
spec names. They wrote it for themselves.

### What people may and may not do

| | Administrators | Others who can edit posts |
| --- | --- | --- |
| Write a customization | for an audience, or "Only for me" | for themselves |
| Save a build | verified or not | only one whose checks passed |
| Approve | everything the policy allows | nothing: read-only ones need no approval |
| Archive | everything not managed | their own |
| See | all customizations, automation, history | their own |

At most ten customizations a person and 25 versions of each, as before.
The site's policy applies to them as to everyone: where it forbids new
customizations there are none of one's own either, and
`graft_personal_authoring` turns them off alone.

### Where it waits

On the same screen for both. The author sees their customization there
with its state ("Needs approval"); the administrator sees it in the list
of all customizations. There is no separate queue and no notification.

## Consequences

- People who write posts can spend the site's model calls, up to the
  daily limit. A site that does not want that sets the limit to 0 or
  turns `graft_personal_authoring` off.
- The package that in-browser verification installs (the plugin's own
  code) is given to anyone who may build, where it was administrators'
  only.
- An unverified build of one's own cannot be saved. Where in-browser
  verification is off or Playground cannot be reached, people cannot
  build their own, and the editor says so before any model call.
- Triggers stay an administrator's decision: a customization with
  triggers is never approved by its author.
- EmDash and the browser extension have no equivalent yet. On EmDash only
  administrators reach the plugin's pages; in the extension every
  customization is already one person's.

## Tests

`pnpm test:wp` covers the rules over REST (a read-only customization
goes live, one that writes waits, an unverified one is refused, people
see and archive only their own, the daily limit, turning it off).
`pnpm test:e2e` covers the screen as a contributor, and in CI, where the
browser can reach Playground, building one from the editor to the
Dashboard.
