# ADR 0018: Previews before approval, and safe mode in the browser extension

- Status: Proposed (prototype in `hosts/chrome-extension`)
- Date: 2026-11-21
- Builds on: [ADR 0011](0011-browser-extension-host.md), [ADR 0013](0013-operating-and-recovering.md), [ADR 0017](0017-browser-activity-undo-and-triggers.md)

## Context

Agent tool interfaces often offer four operations: discover, preview,
apply and revert. Graft already has each one, under names that say who
may do what:

| Operation | What Graft has |
| --- | --- |
| Discover | The surface: the slots, capabilities, scopes and trigger bounds a build may use, generated or probed. The drift probe finds out what an app really serves. |
| Preview | Verification in a sandbox before shipping. The checks, each next to its criterion, before approval. A dry run for triggers. |
| Apply | Approval, which grants a spec version's permissions. A click through the gateway. "Run now". |
| Revert | Undo for one call (ADR 0017). Pause for a trigger. Revoke for a customization. Safe mode for everything, on WordPress (ADR 0013). |

There were two gaps, both in the extension:

1. A person could not see a customization with their own data before
   approving it. They could only read its checks, which run on made-up
   fixtures.
2. The extension had no switch that stops everything. **Pause all**
   stops triggers only. Views keep showing until each is revoked or the
   extension is turned off, and turning it off also hides the options
   page and the activity log, where the person would recover.

We keep the four operations as these specific features rather than four
generic verbs. Each feature is safe because of rules of its own: an
approval needs a person who reads the grant, a dry run makes no write,
and an undo needs no more than the original call did.

## Decision

### A preview reads, and never writes

A customization that waits for approval, and whose build is verified for
the spec and the surface, can be previewed. The options page says what
the preview may read and for how long, and has a **Preview** button.
Pressing it is the person's consent to those reads, for 10 minutes. The
preview is then drawn where the customization would be (the app's page,
or the side panel), titled "(preview)", with a notice that it changes
nothing.

- **What it may read.** The preview's grant is the scopes of the read
  capabilities the build uses, among those the spec asks for
  (`previewGrant`). It never includes the triggers' grants.
- **What it may not do.** The gateway refuses every write in a preview
  (`graft_preview_read_only`), whatever the grant says, so a scope
  shared by a read and a write does not open the write. Every button
  that would call a capability is taken out of the view, and its key is
  not available, so a forged click finds nothing. Local buttons
  (filters, tabs) still work.
- **Where it comes from.** Only the service worker decides that a mount
  is a preview, from its own store. A page cannot ask for one.
- **How it ends.** It ends after 10 minutes, on **Stop the preview**, on
  approval, or when the spec version changes. Triggers never run in a
  preview. A dry run still needs approval.

Reads in a preview go through the gateway like any other, so refusals
and failures are in the activity log.

### Safe mode stops everything, and recovery still works

**Turn on safe mode** at the top of the options page sets one flag. While
it is on:

- no customization is mounted in an app's page or in the side panel;
- no preview is shown or started;
- no trigger runs, on schedule or on "Run now".

The options page keeps working, and so do approving, revoking, Undo and
dry runs, because they are how a person finds and fixes what went wrong.
The options page gives the reason ("Safe mode is on") next to every
customization and trigger it stops. This is ADR 0013's safe mode, for
the browser.

## Consequences

- A person can judge a customization by what it shows them, not only by
  its checks, before granting it anything.
- A preview reads with the person's account before approval. The person
  asks for it, it is limited to reads, and it lasts 10 minutes, but it is
  a read without a grant. A preview of a customization that only writes
  reads nothing and shows little.
- Views already drawn when safe mode or a preview's end arrives stay
  until the page reloads. Their next render or click is refused.
- Not done yet: an organization turning safe mode on by policy
  (`chrome.storage.managed`), and a preview of a trigger's dry run before
  approval.

## Alternatives considered

- **Four generic operations.** They would blur the rules above, and the
  code would have to separate them again inside each one.
- **Previews in place, without asking.** Showing unapproved
  customizations read-only on every page would read the person's data
  for things they never asked for.
- **A preview with fixtures.** That is what the checks already show. The
  gap was the person's own data.
- **Safe mode by turning the extension off.** That hides the options
  page and the activity log, the two places a person recovers from.
