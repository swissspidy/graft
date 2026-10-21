# ADR 0011: A browser extension as the host for apps without a plugin API

- Status: Proposed
- Date: 2026-10-21
- Builds on: [ADR 0001](0001-architecture.md), [ADR 0003](0003-emdash-host.md), [ADR 0008](0008-agency-sites.md), [ADR 0009](0009-a2ui.md)

## Context

Most software people want to customize is a web app they do not run: a
SaaS tool shared by thousands of companies, with no plugin API, or one
too small for the change they want. Today people customize such apps
with userscripts or extensions that someone (lately, a model) wrote.
That is generated code against someone else's DOM, and it breaks on the
next redesign with nobody around to fix it. This is the problem Graft
exists for, in its hardest form.

WordPress and EmDash cooperate with Graft: the plugin runs inside the
host, the host has versions, and the surface is generated from the
host's own registries. A third-party app does none of that. Its
"surface" is its DOM and its HTTP API. Both change without versions or
notice, and nothing of Graft runs on its servers. The questions were:

1. Can a surface describe an app from the outside, and be versioned and
   hashed when the app has no version?
2. Can the upgrade ladder still run when nobody announces upgrades?
3. Can the safety properties hold (no code in builds, a gateway, grants,
   no data outside declared sources) inside a browser extension, under
   Manifest V3?
4. What does verification run against, if not the app?
5. Where do customizations come from, and who approves them?

The prototype (`hosts/chrome-extension`) answers them for a small fixture
app, Tasklet, which plays the part of a third-party task tracker. It has
pages with landmarks, a JSON API behind a session cookie, a CSRF header
on writes, roles, a strict CSP, and three versions that change the way
real apps change.

## Decisions

### The extension is the host, and an app is described from the outside

The host adapter is the extension (`host: browser`). Each app gets its
own surface, written by an adapter author as an *app description*
(`src/apps/tasklet.ts`) and turned into a surface (`appSurface`):

| Graft | In the browser host | Tasklet |
| --- | --- | --- |
| Slot | An **anchor** in the app's DOM: the pages it is on (URL path patterns), CSS selectors tried in order, an ARIA **landmark** (role and accessible name) the element must be, and where the extension's element goes | `project.sidebar`: `/projects/:project`, `[data-testid="project-sidebar"]`, `complementary "Project details"`, append |
| Slot props | One `{ id }` per URL parameter | `{ project: { id } }` |
| Capability | An **HTTP binding** to the app's own API (method, path with `{input}` placeholders, query and body fields, fixed headers), called with the viewer's session | `tasks.list`: `GET /api/projects/{project}/tasks?status&assignee` |
| Capability output | What the build may see: the answer is cut down to it | tasks without the assignee's email |
| Scope | The app roles that may use it, read from the app's "who am I" endpoint | `tasks.status:write`: member, owner |
| Audience | App roles | guest, member, owner |

All slots are extension slots: the extension owns no space in the app.
The anchors, the viewer endpoint and the app's origins are the surface's
`model`, so they are part of the hash: moving an anchor is a new surface.

The landmark is the contract; the selectors are a cache. An adapter
author picks the most stable selector they can find (a test id), but
the anchor is defined by what the element *is* to assistive technology,
which apps change far less often than class names, because changing it
breaks their own accessibility.

### No versions: fingerprints, and drift

The app has no version to put in `hostVersion`, so the surface carries
the **fingerprint** of the app as observed, and `hostVersion` is
`observed-<fingerprint prefix>`. A drift probe (`src/node/drift.ts`)
signs in, visits a page for each slot and resolves its anchor with the
content script's code, and calls each read capability with a probe input
and checks the answer as the gateway does. The fingerprint keeps
structure only:

- for a slot, which selector matched (or that only the landmark did),
  and the element's tag, role and name;
- for a capability, whether the answer matches the declared output, how
  it does not (`/tasks/[] is missing "due"`, with list positions
  removed), and the keys it has that the surface does not declare.

Values never go into it, so the fingerprint does not change when the
probe account's data does (a null due date, an empty list). A different
fingerprint is **drift**. Writes are never probed: nothing may change
data in someone's account to find out whether it still works.

Drift is also noticed where it happens. The gateway records every answer
that no longer matches its schema, and the content script reports
anchors it cannot find, or finds only by their landmark. Those reports
go to the extension's drift log; at scale they are the cheapest probe
there is, because every page view is one.

### Drift is the trigger for the upgrade ladder

The probe writes the **observed surface**: the declared one with what
it found applied, hashed, with the declared hash as `previous`. Every
build then goes up the ladder of ADR 0001 from the declared surface to
the observed one (`upgradeAfterDrift`, `pnpm drift:extension --spec`):

| What changed in the app | Observed surface | Ladder |
| --- | --- | --- |
| A selector broke, the landmark is still there (Tasklet 2) | The anchor's selectors gain the one that finds it now; the slot's contract (what it provides) is unchanged | static check finds no change: **reverify**, survived |
| An anchor is gone (Tasklet 3's toolbar) | The slot is removed | **re-anchor** to its successor or a slot that provides the same props; else regenerate |
| An answer gained fields | Unchanged; the fingerprint records the new keys | Nothing: the gateway drops them |
| An answer lost or renamed a field (Tasklet 3's `due`) | The capability's output is the observed shape | **regenerate** with the frozen checks, or failed (suspended) without a model |
| A write endpoint changed | Not probed | Seen at run time as the app's refusal; the sandbox copy has to be updated |

Re-anchoring therefore happens at two levels. Re-anchoring *in the DOM*
is the adapter's job: the anchor is found again by its landmark, the
builds do not notice, and they are re-verified only because the surface
hash changed. Re-anchoring *a build* is the ladder's rung, when a slot is
really gone. The content script does the first one live: a sidebar found
only by its landmark still gets its customization, and the drift log
records that it moved.

This is weaker than WordPress and EmDash in one way that matters: the
ladder runs *after* the app changed, not ahead of it. There is no next
version to canary against. The gap is as long as it takes the next probe
or page view to notice. An answer that no longer matches its schema
fails closed: users see a customization that says its data could not be
loaded, not wrong data. A change that keeps the shape but changes the
meaning (a field that now holds something else) passes the schema check
and the fingerprint alike, and is not detected; only the checks in a
faithful copy, or people, would notice it.

### The gateway lives in the service worker

Content scripts run in the app's pages, so they are treated as the
page's: they hold no data and no capabilities. The service worker holds
the surfaces, the customizations and their grants, renders each build
into a plain view (text, buttons, tables), and keeps what every button
does. A content script only ever sends a customization id, the key of a
button the person clicked, and the state it was given. The service
worker renders again and runs the button only if that render offers it
(the EmDash design of ADR 0003). A call then goes out only if:

- the sender is the extension's own content script, in a top-level
  frame, and the page (the URL Chrome reports, never one the page
  claims) is on one of the app's origins and has the slot;
- the customization is approved, its build is verified for this spec
  version and this surface, and its grant covers the scopes its build
  uses (computed from the build, not from its stored refs);
- the build uses the capability, the grant covers the capability's
  scopes, and the input matches its schema.

The request goes to the page's own origin, to the binding's path, with
path parameters encoded (an input of `../members` stays one segment),
redirects refused, and the session cookies the browser holds for that
origin. The answer is cut down to the declared output and must then
match it, or it is drift, not data. The app's own permission checks
still decide every call: the gateway is what keeps a customization
inside what the person approved.

### Manifest V3, permissions and isolation

- **No code in builds, none fetched.** Builds are data; the renderer,
  gateway and content script are in the extension package. MV3 forbids
  remote code, which is exactly Graft's rule. It also forbids generated
  code (`eval`, `new Function`) in the service worker, so schemas are
  validated with the cfworker engine of ADR 0004, and the build fails if
  a bundle contains either.
- **Minimal permissions, from the surfaces.** The manifest is generated
  (`extensionManifest`): `host_permissions` are the apps' origins, the
  content script matches only pages with slots, and the only API
  permission is `storage`. There is no `externally_connectable` and no
  `web_accessible_resources`, so no web page can message the service
  worker or detect the extension by its resources.
- **The page's CSP does not apply; the extension's does.** The content
  script draws with DOM APIs only (no markup is parsed), and styles come
  from a constructed stylesheet adopted by its shadow root, which Tasklet's
  `style-src 'self'` does not block. Extension pages use
  `script-src 'self'; object-src 'none'`.
- **The shadow root is open, and only trusted clicks count.** A closed
  root would hide the customization's DOM from the page, but everything
  it shows comes from the app's own API, which the page can read anyway.
  What matters is that the page cannot *drive* it, so clicks the page
  synthesizes (`isTrusted` false) are ignored. An open root also keeps
  the customization reachable for assistive technology and tests.
- **What it cannot stop.** A compromised page (or renderer) can send the
  key of a button the person was shown, which is no more than the page
  can already do with the person's session. It cannot name a capability,
  an input, another customization's buttons or another app's origin. An
  extension update or a compromised extension is outside Graft's model,
  as a compromised WordPress plugin is on WordPress.

### Verification runs against a copy, never an account

A sandbox for this host is a copy of the app: anything that serves the
app's pages and API and also speaks a small **fixture protocol**
(`/__fixture/reset`, `seed`, `instances`, `assert`). Checks seed fixture
users and tasks, and capability calls go through the same bindings and
projection as the gateway, as fixture users signed in to the copy. For
the prototype the copy is the Tasklet fixture server. For a real app it
is a contract fake that the adapter author maintains with the app
description (recorded answers, a hand-written mock, or a test instance
where the vendor offers one).

A copy is only as good as its fidelity, so the fake's fingerprint has to
equal the live app's. The drift probe runs against both: when the live
app drifts, the copy must be updated to drift the same way before the
ladder's verification means anything. In the prototype the fixture's
version switch plays that role (the ladder re-verifies against Tasklet 2
after Tasklet 2 is observed).

Verification is semantic, as everywhere in Graft: it does not look at
where the customization is drawn. An anchor that resolves to the wrong
element would pass its checks; the landmark rule (exactly one element of
that role and name) is what makes that unlikely. Owners should hear of a
slot re-anchored in the DOM as they do of a re-anchored build (ADR 0001's
outcome policy). The drift report and log name it; telling owners is not
built yet.

### Distribution and approval

Customizations travel as the bundles of ADR 0008 (`graft bundle`): the
spec, and builds with their verifications, per surface hash. In the
prototype the extension ships them in its package and installs those
that validate against a shipped surface, waiting for approval. Approval
is the person's, on the extension's options page: what each one may do
in plain language and every check next to its criterion, as in
Tools → Customizations. Grants belong to a spec version, so a new
version waits for approval again, and a build that needs more than its
grant is not served.

Later sources, all data and none code, so MV3 allows fetching them:

- **A Graft server** that publishes signed bundles per app and surface
  hash, and the observed surfaces from its own probes, so one probe and
  one ladder run serve every user of the app.
- **An agency or an IT team** that maintains the app description, the
  copy and bundles for its client's SaaS, the browser counterpart of ADR
  0008. Approval can then move to the organization: Chrome's managed
  storage (`chrome.storage.managed`, set by enterprise policy) can carry
  pre-approved grants and an allow list of bundle sources.
- **Local authoring** in the options page, compiling against the app's
  surface with the person's own model key, verified against the copy.

### What this host can and cannot promise

| | WordPress | EmDash | Browser extension |
| --- | --- | --- | --- |
| Surface | Generated from the host's registries | Declared by the adapter, from the host's API | Declared from the outside, kept honest by probing |
| Versions | WordPress releases | EmDash releases | None: the observed fingerprint |
| Upgrades | Prepared ahead by the canary | Prepared ahead by the canary | After the app changed, from drift |
| Gateway | Server side, then WordPress capabilities | In-process, then EmDash RBAC | Service worker, then the app's own API |
| Verification | The real host in Playground | A throwaway EmDash | A copy the adapter author keeps faithful |
| Slots | Hooks the plugin registers | The extension points EmDash has | Any element with a landmark: more places, more fragile |
| Who approves | A site administrator | An administrator | The person, or their organization by policy |
| Tenancy | A site | A site | A browser profile |

The extension can promise everything about what a customization may do:
no code, declared data only, the approved grant, refusals before the
request. It cannot promise that a customization keeps working across an
app change it never heard of, only that it notices, says so, and goes up
the ladder. Its guarantees protect the person using it, not the app:
anyone can turn off their own extension.

## Alternatives considered

- **Userscripts** (Tampermonkey, or MV3's `userScripts` API). They are
  code by definition, run in the page with its full power, and have no
  place for a gateway outside the page. A generated userscript is the
  rotting artifact Graft replaces. The renderer could be delivered as one,
  but grants and capability calls would then be enforced by the page they
  protect.
- **Bookmarklets.** They run in the page's world, many apps' CSPs block
  them, they keep nothing between uses (no grants, no store), and they
  have no background context for a gateway or probes.
- **The app's own extension points** (Slack and Jira apps, Google
  Workspace add-ons, Salesforce, Shopify, HubSpot UI extensions). Where
  they exist they are better: real versions, server-side enforcement,
  every user of a workspace at once. Each is its own Graft host, as
  EmDash is. The extension is for apps that have none, or none where the
  change belongs; an adapter for an app with both should prefer its own.
- **Code in the page's main world**, to use the app's own JavaScript or
  state. Rejected: the page could then tamper with the renderer and the
  gateway, and the app's internals change more often than its DOM.
- **Driving the app's UI** (clicking its buttons, filling its forms) as
  capabilities. Rejected for writes: more fragile than the API, and
  unverifiable against a copy. The API the app's own front end calls is
  the closest thing to a contract it has.
- **A rewriting proxy** in front of the app. It would see all traffic and
  credentials, break with TLS pinning and SSO, and is far heavier to run
  than an extension.
- **A closed shadow root.** See above: it hides nothing the page cannot
  read and costs accessibility; trusted-click checks address the real
  risk.

## Implementation

The prototype in `hosts/chrome-extension`:

- `fixtures/tasklet`: the target app, in three versions, with the fixture
  protocol.
- `adapter/src/host`: the surface (`surface.ts`), URL patterns, HTTP
  bindings and projection, anchors, the `graft:browser` A2UI catalog and
  view renderer, the gateway.
- `adapter/src/extension`: the MV3 service worker, content script,
  options page and manifest; `scripts/build-extension.ts` builds the
  unpacked extension.
- `adapter/src/node`: the sandbox, the drift probe, the ladder after
  drift, and the CLI (`pnpm surface:extension`, `pnpm drift:extension`).
- `examples/chrome-extension`: the "My open tasks" spec, its build (seven
  checks, verified with `pnpm verify:extension`) and its bundle.

Tests: unit tests for pages, bindings, projection, the gateway against
the fixture app, the surface and the manifest (`pnpm test`). In Chromium
with the unpacked extension (`pnpm test:e2e:extension`): nothing shows
before approval on the options page; the customization is drawn in the
sidebar and styled under the app's CSP; "Done" marks a task done through
the gateway; a guest gets no button and a forged click or capability is
refused before any request; a build that needs more than its grant is
not served and makes no request; after the app changes, the sidebar is
found by its landmark and the drift is logged. The drift tests run the
probe on all three versions and take the build up the ladder: no drift;
re-anchored and survived; regenerate (failed without a model).

`packages/core` and `packages/a2ui` needed no changes. The CLI learned the
`browser` host (`validate`, `build`, `verify`, `bundle`).

## Consequences

- Graft's contracts held for a host that does not cooperate. What changed
  is where the surface comes from (declared, then observed) and when the
  ladder runs (after drift instead of ahead of a release).
- Adapter authors now maintain three things per app: the description,
  the probes and the copy. Drift detection turns that from "notice it
  broke" into a report of which slot or capability broke and which
  builds it takes up the ladder.
- Not done yet:
  - inputs (text fields, checkboxes) in the browser catalog;
  - single-page-app navigation without a page load (the content script
    redraws when anchors appear or are removed, not on history changes);
  - scheduled probes from the extension itself (`chrome.alarms`), and a
    server to aggregate drift and serve observed surfaces;
  - signed bundles from a Graft server, organization policy through
    managed storage, authoring in the options page;
  - CSRF tokens read from the page (only fixed headers are bound);
  - per-object permission refinement (`can` on a row), a canary corpus
    and synthetic scenarios for this host, and Firefox.
