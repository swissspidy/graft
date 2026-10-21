# ADR 0010: Scheduled actions: triggers that act without a viewer

- Status: Proposed (prototype on WordPress)
- Date: 2026-10-21
- Builds on: [ADR 0001](0001-architecture.md), [ADR 0002](0002-authoring-and-operations.md), [ADR 0008](0008-agency-sites.md), [ADR 0009](0009-a2ui.md)

## Context

Until now a build only does something when a person views a page or
clicks, and it acts as that person, through the gateway. Many of the
small changes people ask for are not like that:

- "Every morning, tag posts that have waited in review for more than a
  week."
- "When a post is published, set its field X."
- "Every day at 09:00, nudge the editor about posts pending for over seven
  days."

Each of these runs with nobody watching. This is the first feature that
does, so who it acts as, what bounds it runs within, and how an
administrator sees and stops it matter more than the feature itself. It
also has to fit the rest of Graft: no code in builds, frozen checks
before anything goes live, and the upgrade ladder when the host changes.

## Decision

### A trigger is part of the build, and the spec declares it

The spec declares each trigger: when it runs, and what it may do. Both
are decisions a person makes and an administrator approves, so they go
in the manifest, like `mount` and `permissions`:

```yaml
triggers:
  flag-stale:
    schedule: { every: 1d, at: "09:00" }
    permissions: [posts:read, posts.terms:write]
    limit: 20
  clear-on-publish:
    event: post.published
    permissions: [posts.terms:write]
```

- `schedule` (every so many hours or days, days optionally at a time of
  day in the site's time zone) or `event` (from the surface).
- `permissions`: the scopes this trigger's service identity is granted,
  separate from the viewer's `permissions`.
- `limit`: the per-run cap.

The build carries how it is done, next to `data` and `events`:

```json
"triggers": {
  "flag-stale": {
    "schedule": { "every": "1d", "at": "09:00" },
    "targets": { "call": "posts.list", "input": { "status": ["pending"], "orderby": "modified", "order": "asc", "per_page": 100 } },
    "where": { "$gt": [{ "$daysSince": { "$target": "modified" } }, 7] },
    "call": "posts.set_terms",
    "input": { "id": { "$target": "id" }, "taxonomy": "post_tag", "terms": ["waiting-too-long"], "mode": "add" },
    "once": true
  }
}
```

- A scheduled trigger reads its **targets** with one read capability call
  and a fixed input.
- An event trigger has one target: the event's **subject** (the post that
  was published).
- `where` keeps the targets the trigger acts on.
- The trigger makes **one capability call per target**. `$target` reads
  the target in `where` and `input`.
- `once` acts on each target, by id, at most once; a failed call is
  retried on the next run. Without it, a trigger whose `where` still
  holds acts on the same targets every run, and a per-run cap can starve
  the targets after them.

The expressions are the data-source language of ADR 0001 (`$eq`, `$and`,
`$or`, `$not`, comparisons, `$if`, `$daysSince`) plus `$target`. There is
no viewer, slot or page data: `$can`, `$slot` and `$data` are refused in
a trigger, and `$target` is refused everywhere else.

Builds without triggers are unchanged, and so are their refs.

### Static validation

The build validator checks each trigger before anything runs, the same
way it checks data sources:

- The surface runs triggers at all.
- Every trigger the spec declares is implemented, and none it does not.
- It runs when the spec says.
- It runs no more often than the surface's `minInterval`; `at` only goes
  with days.
- Its event is one the surface declares.
- Its targets come from a read capability.
- Both of its capabilities are ones the surface lets triggers use.
- Its inputs validate against the capabilities' schemas, with bindings
  exempted as for data sources.
- Every `$target` names a property of the target's schema: the targets
  capability's list items, or the event's `provides`.
- It needs no scope beyond the permissions the spec lists for it. This
  is an error when compiling and a warning when upgrading, as for viewer
  scopes, so an upgrade can exit as *needs approval*.

The spec validator checks the manifest against the surface: known event
and scopes, the interval, `limit` within `maxPerRun`, and that each scope
is one some trigger capability needs ("granting it does nothing"
otherwise).

### The surface says what triggers may do

A surface gets an optional `triggers` section. It is part of the
contract, so it is hashed:

```json
"triggers": {
  "minInterval": 3600,
  "maxPerRun": 50,
  "maxEventRunsPerHour": 60,
  "capabilities": ["posts.list", "posts.set_terms", "posts.update_fields", "posts.update_status", "terms.list"],
  "events": { "post.published": { "title": "A post is published", "provides": { /* the post */ } }, "post.submitted": { } }
}
```

A host without it (EmDash, for now) runs no triggers, and a spec that
declares one does not validate against it.

WordPress declares it by default, with a `graft_surface_triggers` filter
to change it or return null for none:

- **Capabilities.** The content reads and writes, and
  `posts.update_meta` where the site exposes fields. Not `site.info` or
  `users.current`: site settings and "the current user" mean nothing to an
  automation user.
- **Events.** A post of an exposed type is published, or submitted for
  review.

Like the content model in ADR 0008, it is code, not a setting.

### A trigger runs as a service identity with its own grant

A trigger never acts as its author, as the administrator who approved
it, or as the last viewer. On WordPress it runs as **Graft automation**
(`graft-automation`), one user per site:

- **No role.** Outside a run it has no capabilities at all.
- **Capabilities only during a run.** During a run of one trigger,
  `user_has_cap` gives it the WordPress capabilities that trigger's
  granted scopes map to, and only those. It works on everyone's posts, so
  `edit_posts` becomes the post type's `edit_posts`, `edit_others_posts`,
  `edit_published_posts`, `edit_private_posts` and `read_private_posts`
  for each exposed post type. `publish_posts` maps the same way, and
  `posts.terms:write` adds `assign_terms` in exposed taxonomies. Nothing
  that manages the site is ever added.
- **No sign-in.** Signing in is refused, and application passwords are
  off for it.
- **Its own name on what it does.** Its id is in the run log and in the
  gateway's refusal log.

The grant is per trigger. Approving a version grants the viewer scopes as
before, and `grant.triggers.<id>`: what the spec lists for that trigger,
plus what its build needs. One trigger's grant never covers another's,
and none covers a viewer's.

The rule that grants never widen silently (ADR 0001) covers trigger
grants too:

- A version activates on its own only when its grant covers the viewer
  scopes and every trigger's scopes (`grant_covers_build`). Otherwise it
  waits for approval, also after an upgrade.
- On the upgrade ladder, a candidate whose trigger needs a scope beyond
  that trigger's grant exits as *needs approval*
  (`extraTriggerScopes`). It is verified with the widened trigger grant,
  so it is known to work once approved.

**Approval is shown where it already happens.** In Tools →
Customizations, a version with triggers has a "Runs on its own" section
next to its permissions and checks, for example:

> every day at 09:00, at most 20 at a time (flag-stale), may: see posts
> you can edit (granted); change the categories, tags and other terms of
> posts you can edit (granted)

It names who it runs as and that it can be paused. The trigger checks
read as sentences too ("and "flag-stale" runs on its own, then the run of
"flag-stale" acts on 1 target"), so the administrator approves the
schedule, the grant and the proof together, with the Approve button they
already use.

### Every call goes through the gateway

A trigger's calls take the gateway's checks, in order:

1. the trigger uses the capability;
2. the host lets triggers use it;
3. the trigger's grant covers its scopes;
4. the policy, as it is now, allows them (unless the site's maintainer
   ships the customization, as for viewers).

Only then does the ability run, with its own WordPress permission check
on top, as the automation user. Refusals go to the gateway's existing
refusal log (`graft_gateway_refused`, GET `graft/v1/audit`) with the
trigger's id.

Before a run starts, the runner checks:

- the customization is active, with a build for this surface;
- the trigger is not paused;
- triggers are not turned off;
- the stored grant covers what the trigger needs, computed from the
  host's capability map and never from the build;
- the policy allows it.

### Bounds

- **How often.** A schedule runs no more often than the surface's
  `minInterval` (one hour on WordPress) and the policy's. WordPress runs
  one hourly WP-Cron tick (`graft_triggers_tick`) that starts the
  triggers that are due. A new trigger waits for its first slot after it
  became active, instead of running at once.
- **How much.** Each run makes at most `limit` calls (the spec's,
  within the surface's `maxPerRun` and the policy's `max_per_run`).
  Targets over the cap are reported as left for the next run.
- **Events.** An event never runs a trigger in the request of the person
  who caused it. It queues a single WP-Cron job
  (`graft_trigger_event`), and the job runs the trigger as the automation
  user. An event trigger runs at most `maxEventRunsPerHour` times an hour;
  later events are dropped and logged as such.
- **No chains.** Events caused by a trigger run start nothing, so
  triggers cannot set each other off.
- **Failures.** A failed call does not stop the run. Three failed runs in
  a row pause the trigger, with the reason shown.
- **Stopping.** An administrator can:
  - pause one trigger;
  - pause all of them;
  - turn them off for good (`GRAFT_DISABLE_TRIGGERS` in `wp-config.php`).
  The policy can forbid them too.
- **Dry run.** A dry run reads the targets and plans the calls without
  making them, and is logged as a dry run. It works on a paused trigger,
  so an administrator can see what it would do before resuming it.

### The policy

ADR 0008's `graft_policy` gets a `triggers` key:

| Value | Meaning |
| --- | --- |
| `true` (default) | As far as the rest of the policy allows |
| `false` | Customizations may not act on their own |
| `{ scopes, events, min_interval, max_per_run }` | What their automation may be granted, which events they may run on, how often and how much |

It is enforced when a spec is saved, when a version is approved (what
the spec declares and what its build needs), and before every run and
call. Like the rest of the policy, it only narrows, and a policy
tightened after approval applies at once. Tools → Customizations shows
it in plain language.

### Audit

Every run is logged with:

- when, and the automation user's id;
- the customization, version and trigger;
- how it started: schedule, event, manual or dry run;
- its status: done, partly failed, failed, refused, dropped or dry run;
- how many targets it read and matched, and how many it left for the
  next run;
- each call: the target's id and title, the input, and whether it went
  through, with the error.

The latest 200 runs are kept, and `graft_trigger_ran` fires for site
logging. Refusals also go to the gateway's log, so "what did Graft refuse
on this site" stays one list.

Tools → Customizations has a "Running on their own" panel. It lists
every active trigger with:

- when it runs, its cap and `once`;
- what it may do;
- its state, last run and next run;
- buttons to pause or resume it, try it as a dry run, or run it now.

Under that are the recent runs in plain language ("acted on 1 of 3: Stuck
in review") and the pause-all switch. The REST routes behind it
(`graft/v1/triggers`, pause, resume, run) are for administrators only.

### Verification: checks run triggers in the sandbox

A check can now run a trigger. Its step `{"trigger": "<id>"}` runs it
right then:

- at the check's clock, so `clock.advanceDays` makes "older than seven
  days" testable;
- as the automation user, with only the permissions the spec lists for
  that trigger.

For an event trigger, `"target": {"title": …}` picks the subject among
the fixtures, and the event first happens to it the way it does on the
site: the sandbox publishes the post. The view is drawn again afterwards,
so a check can assert what the viewer sees after a run.

A new expectation, `{"run": {"trigger", "calls", "failed", "skipped",
"matched", "status"}}`, asserts what the latest run did. The host's
assertions (`post` with `terms`, `meta`, `status`) show what it changed.

The verifier hands the run to the sandbox (`Sandbox.fire`), and the
WordPress sandbox runs the plugin's own runner and gateway checks. The
checks therefore prove the code that runs on the site, not a model of
it. A host whose sandbox cannot run triggers fails such checks with that
reason.

Checks are written from the criteria before any build exists and then
frozen, as before. Activation still requires a build that passes them.
The compiler's checks phase is told about trigger steps and run
expectations only when the spec declares triggers.

### One evaluator in TypeScript, one in PHP, one conformance file

Core runs triggers with `runTrigger()` (targets, `where`, the cap,
`once`, dry runs) over an injected `call`. TypeScript hosts and the
verifier's fake hosts use it, and so would EmDash.

The WordPress runner has to run in PHP, inside WP-Cron, so it
reimplements the trigger subset of the expression language and the run
loop. `fixtures/triggers/expressions.json` lists expressions with their
expected values; the core's unit tests and the plugin's smoke test both
run them, so the two implementations cannot drift apart unnoticed.

### Upgrades

Triggers carry refs like the UI does. `refs.triggers` lists their events,
capabilities and scopes, and is present only when the build has
triggers. The ladder covers them:

- **Static check.** A trigger's capability that is removed, changed, or
  no longer allowed unattended counts as a change. So does an event that
  is removed or whose subject changes; a compatible change to the subject
  (it provides more) does not need a rebuild.
- **Migrate.** Surfaces can rename or remove events (`kind: "event"`).
  Capability renames apply to a trigger's `call` and `targets.call`.
- **Regenerate.** The compiler asks for `triggers_json` next to the UI
  phase's output. The prompt includes the trigger vocabulary, what each
  trigger may use, and the triggers of the build being replaced, so a
  regenerated build keeps its triggers and is verified against the same
  frozen checks.

## Example

`examples/specs/waiting-too-long.md`:

- A Dashboard widget of the pending posts tagged "waiting-too-long".
- `flag-stale`: every day at 09:00, at most 20 a morning, once per post,
  tags pending posts untouched for more than seven days.
- `clear-on-publish`: takes the tag off a post when it is published.

Its build passes 9 checks in the WordPress sandbox. They cover:

- tagging the stale post;
- leaving fresher, draft and published posts alone (at seven days and at
  eight);
- tagging once;
- the cap of 20 with 21 posts;
- untagging on publish;
- the widget;
- the empty state.

The checks catch wrong builds. A threshold of 6 days, a missing `once`,
and `add` instead of `remove` each fail exactly the check for their
criterion.

Tests:

- `pnpm test` (core):
  - the runner, the gateway checks and the validators;
  - verification with trigger steps, and with a narrower trigger grant;
  - the static check, migrations and needs-approval on upgrade;
  - compiling with triggers;
  - the conformance file.
- `pnpm test:wp` (on PHP 7.4 and 8.4):
  - the conformance file in PHP;
  - the automation user: no role, no sign-in, no application passwords,
    capabilities only in a run;
  - per-trigger grants on approval;
  - the schedule: waits for its first slot, then 09:00;
  - `once`, dry runs, pausing and pause-all;
  - the policy: forbid, narrow scopes, narrow events;
  - the gateway refusing a trigger's undeclared or ungranted calls, and
    logging them;
  - an event queued to WP-Cron rather than run in the request;
  - no chains;
  - the event rate limit;
  - pausing after three failures.
- `pnpm test:e2e` (`triggers.spec.ts`), in wp-admin:
  - the grant on the approval card;
  - the panel;
  - a dry run;
  - pausing;
  - running now, and the Dashboard widget afterwards;
  - publishing a post, after which WP-Cron runs the event trigger;
  - pause-all;
  - non-administrators refused.

## Consequences

- Customizations can keep a site tidy on their own, with no code. Each
  one runs as an identity that can do exactly what was approved for that
  trigger, and only while it runs.
- The WordPress surface changed: it now has a `triggers` section, so its
  hash changed. Every example, agency and canary build targeting it was
  re-stamped, and the agency site's surface was regenerated. A live site
  that updates the plugin sees a host change, as after a WordPress
  update: its customizations wait in *upgrading* until an administrator
  runs Check and upgrade in Tools → Customizations. There, builds without
  triggers start at *reverify* (none of their refs changed) and survive
  once their checks pass again.
- The trigger evaluator exists twice, in TypeScript and PHP, held
  together by the conformance file and the sandbox verifying the PHP
  runner itself.
- WP-Cron runs on page views unless the site uses a real cron. On a quiet
  site, "every day at 09:00" means the first tick after 09:00. Runs are
  at most hourly by design, so this is accepted rather than worked
  around.
- Without a "contains" in the expression language, a trigger cannot say
  "posts without the tag". `once` covers the common case: tag each post
  once, and respect a person removing the tag. The cost is that
  clear-on-publish calls `set_terms` on every published post, whether or
  not it has the tag.
- A trigger can depend on site state that its checks seed but the site
  may lack. The example needs the "waiting-too-long" tag (`set_terms`
  never creates terms). The e2e suite first ran without it: every post
  published in the other tests failed its clear-on-publish run, and after
  the third the trigger paused itself, as designed, so later publishes
  queued nothing. The auto-pause did its job. The spec lists the tag as a
  precondition, but nothing yet checks a site meets it before
  activation. Showing the last failure next to the paused state (the
  panel does) is the minimum.
- `graft site pull` exports viewer grants only. A pulled tenant's
  triggers are upgraded in the canary with the permissions their spec
  lists.

## Out of scope

- **EmDash.** Its surface has no `triggers`, so specs with triggers do
  not validate there. Its plugin would run triggers from EmDash's
  scheduled tasks, with core's `runTrigger()` and the same gateway
  checks. The sandboxed format needs a way to act without a request,
  which EmDash's sandbox API does not offer yet.
- **Notifications.** "Nudge the editor" needs a capability that sends
  something outside the site (email, a Slack message). That is the most
  consequential unattended action, so it gets its own capability, scope
  and rate limits in a later decision, not a side door here. The example
  uses a tag instead.
- **Cron expressions.** `every` with an optional `at` covers the
  requests we have, and reads well in an approval. Weekdays only, or "the
  first Monday", wait for a spec that needs them.
- **More events.** Comments, users and term changes. Each event is a
  subject schema and a hook. Two prove the shape.
- **Chaining and workflows.** No trigger output feeds another, and one
  trigger makes one kind of call. A sequence of calls per target is a
  different, riskier feature.
- **Triggers without a UI.** A spec still mounts somewhere. A trigger's
  customization should show what it acts on (the example's widget), and
  the mount keeps the rest of the model (slots, re-anchoring) unchanged.
- **Running on the server at deploy time,** or across a multisite
  network. One site runs its own triggers.
- **Signed run records.** Run logs are as trustworthy as the site's
  administrators (ADR 0002's signed verification would extend to them).

## Alternatives considered

- **Run as the author, or as the approving administrator.** Simplest,
  and wrong. The author's rights change over time, and an
  administrator's are far wider than the trigger needs. A trigger would
  carry everything its human can do, with nobody watching. A service
  identity with a per-trigger grant keeps "what was approved" and "what
  can happen" the same set.
- **A dedicated WordPress role with fixed capabilities.** A role would
  hold the union of every trigger's needs, all the time. Capabilities
  granted per run from that trigger's grant are narrower, and leave
  nothing to misuse between runs.
- **Run the build's TypeScript on the server.** WordPress hosting has no
  JavaScript runtime to rely on, and the gateway and abilities are PHP.
  A second evaluator, small and checked against the first, is cheaper and
  safer than a runtime dependency.
- **Verify triggers with core's runner against the sandbox's
  capabilities.** That is what TypeScript hosts get. For WordPress it
  would verify a model of the runner, not the runner that runs. Handing
  the run to the sandbox proves the PHP runner, including its gateway
  checks and the automation user's capabilities.
- **Event triggers in the request that caused them.** Immediate, but they
  would run while the person's request is in flight, slowing or breaking
  it, and next to their session. A WP-Cron job runs them apart, as the
  automation user, at the cost of some latency.
- **Off by default, behind a code-level opt-in.** No surface hash change
  and no re-stamped builds. But most WordPress sites have no one writing
  code, so the feature would be invisible to them. Everything else in the
  surface is available by default and narrowed by the policy, and every
  trigger still needs an administrator's approval. The filter and the
  policy can turn triggers off.
- **Cron entries per trigger.** One WP-Cron event per scheduled trigger
  mirrors the schedule directly. It also leaves entries behind whenever a
  version, grant or surface changes. One tick that reads the active
  builds each hour cannot drift from them.

## Open questions

- Should a new trigger's first run be a dry run that an administrator
  confirms? Today the approval, the frozen checks and the dry-run button
  cover it. A forced first dry run would add a step to every approval.
- How long should run logs be kept? Today it is a count. A site with
  busy event triggers may want time-based retention, or logging to its
  own system through `graft_trigger_ran`.
