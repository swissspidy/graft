# Graft

Durable, spec-driven customizations for multi-tenant apps.

AI lets people who don't write code customize software, but what they get
is generated code, which breaks when the host app updates and which nobody
around can maintain. In Graft, a customization's source of truth is a short
**spec**: what it should do, how we know it does it, and what it may touch.
Graft compiles the spec into a declarative UI **build** for one version of
the host, **verifies** the build against the spec's acceptance criteria, and
when the host changes, **migrates, re-anchors or regenerates** the build and
verifies it again. The spec is the contract, the criteria are the guarantee,
and the platform can change underneath.

## Try it

[![Try in WordPress Playground](https://img.shields.io/badge/Try%20in%20WordPress%20Playground-3F57E1?style=for-the-badge&logo=WordPress&logoColor=ffffff)](https://playground.wordpress.net/?blueprint-url=https://swissspidy.github.io/graft/blueprint.json)

This opens a throwaway WordPress in your browser with Graft and the example
customizations installed, in a small newsroom with pending posts and drafts.
The Dashboard shows the headline check, stale drafts and the "Pending by
author" widget. **Tools → Customizations** lists every customization with
its checks in plain language, and "Waiting for review" is left for you to
approve. Every account's password is `password`. Sign in as `edna` (editor)
for the review queue under **Posts** and the quick-approve row action, or
as `ada` (contributor) to see the same queue without the Approve button.
Open any draft in the editor (as `edna`, try "Year in review (outline)")
for the **Publish checklist** in the sidebar: fix the headline and
excerpt there, watch the checklist follow as you type, save, and publish.
The demo is rebuilt from `main` on every push
(`pnpm demo:build`, `pnpm test:demo`).

The example customizations in the demo are A2UI surfaces Claude compiled
from the specs, checked in so the tests run without a model. [Compiling with Claude](docs/compiling-with-claude.md)
shows a real run: Claude compiles all seven example specs into builds that
pass their checks, and regenerates five customizations after a host change.

## A customization

```markdown
---
graft: 1
id: review-queue
host: wordpress
mount:
  slot: admin.page
  menu: { parent: posts, title: Review queue }
audience: [editor, contributor]
permissions:
  - posts:read
  - posts.status:write
---

# Review queue for editors

Editors see only posts that need review, with title, author and submission
date, and can approve with one click.

## Acceptance criteria

- Only posts with status "pending" are listed {#pending-only}
- Columns: title, author, submitted date {#columns}
- "Approve" sets status to "publish" and removes the row {#approve}
- Contributors cannot see the approve button {#contributors-no-approve}
- When nothing is pending, the page says "Nothing to review" {#empty-state}
```

More in [`examples/specs`](examples/specs): an admin page, a row action on
the existing Posts screen, Dashboard widgets, and a publish checklist in
the block editor with fields to fix the headline and excerpt. The same ideas for
EmDash are in [`examples/emdash`](examples/emdash): a publish queue, a
panel in the entry editor, dashboard widgets, and a status board that
switches between drafts and published posts.

## How it works

**Build.** A build is data, not code: an [A2UI](https://a2ui.org/) surface
of components from Graft's catalog for the host (table, button, text,
inputs, ...), bindings into data sources, and events bound to the host's
capabilities (WordPress abilities). A trusted renderer draws it with native
wp-admin components ([ADR 0009](docs/adr/0009-a2ui.md)). It also carries
executable **checks**, one or more per acceptance criterion.

**Serve.** The WordPress plugin mounts active builds in their slots. Every
data read and action goes through a gateway that checks the viewer, that the
build uses the capability, and that an admin granted its permission scope,
before the ability's own WordPress permission check runs.

**Verify.** The verifier renders a build headlessly for a fixture user
inside a throwaway WordPress, through real ability calls, and asserts over a
semantic snapshot (rows, columns, text, available actions, resulting post
state). No tenant data is ever touched.

**Compile.** Claude writes the checks from the criteria first, without
seeing any implementation, and those checks are frozen. It then builds the
UI against them; each candidate is validated against the host's surface
and verified, and failures go back to the model. The model never grades its
own homework. Criteria that can't be checked objectively ("looks clean") are
sent back to the author instead of getting a weak check.

**Upgrade.** Each host version publishes a **surface** (slots, components,
capabilities, scopes) with a content hash. When it changes, every build goes
up a ladder until a candidate passes its frozen checks on the new host:

| Rung | When | Outcome |
| --- | --- | --- |
| reverify | nothing the build uses changed | survived |
| migrate | every change has a declared migration (renames) | migrated |
| re-anchor | only the mount point moved | re-anchored |
| regenerate | anything else: recompile with the frozen checks | regenerated |

A candidate that needs a permission outside the grant stops at *needs
approval*; if nothing passes, the outcome is *failed*. `graft canary` runs
this for every tenant ahead of an upgrade, sharing work between identical
customizations, so builds for the next WordPress are ready before it is
installed.

## Authoring in wp-admin

1. An administrator opens **Tools → Customizations → New customization**,
   writes a spec (validated against the site as they type) and clicks
   **Build it**. The compiler runs in the browser and builds an A2UI
   surface ([ADR 0009](docs/adr/0009-a2ui.md)); model requests go through
   the site's WordPress AI client, so provider keys never reach the browser.
2. The checks run in a private, throwaway WordPress started in the admin's
   browser ([Playground](https://wordpress.org/playground/) in a hidden
   iframe, with this site's plugin installed). Failing candidates go back to
   the compiler; a passing build is saved verified.
3. The administrator reviews the permissions and every check in plain
   language, next to the criterion it proves, and approves it.

Where Playground can't start (offline, blocked), the build is saved as an
unverified draft, and
`graft site verify --site <url> --user <admin> --password <application password>`
verifies it from a terminal instead.

## Run it locally

Requires Node 24+ (the current LTS) and pnpm. Playground is fetched on demand (network access
needed the first time).

```sh
pnpm install
pnpm build                             # bundle the plugin's client
pnpm exec tsx hosts/wordpress/e2e/server.ts   # a seeded WordPress on :9400
```

Log in at http://127.0.0.1:9400/wp-login.php as `admin`, `editor`,
`contributor` or `subscriber` (password `password`). Editors find **Posts →
Review queue** and an **Approve** row action on pending posts. Admins find
**Tools → Customizations**, where "Waiting for review" waits for approval
before it appears on the Dashboard.

`pnpm exec tsx hosts/wordpress/e2e/agency-server.ts` serves a client site an
agency built instead, on :9402: the Riverside Arts Centre, with events and
Lumen Studio's policy. Admins see the policy and the agency's managed
**Upcoming events** widget in Tools → Customizations, and approve the
centre's own **Family friendly** row action for **Events**.

## Commands

```sh
# Specs and builds
pnpm graft validate --surface hosts/wordpress/plugin/surfaces/7.1.json examples/specs
pnpm graft build examples/builds/review-queue.json \
  --surface hosts/wordpress/plugin/surfaces/7.1.json --spec examples/specs/review-queue.md [--fix-refs]
pnpm graft verify --surface hosts/wordpress/plugin/surfaces/7.1.json --spec examples/specs examples/builds/*.json
pnpm graft verify --surface hosts/emdash/adapter/surfaces/1.0.json --spec examples/emdash/specs examples/emdash/builds/*.json
pnpm graft bundle --spec examples/agency/specs/upcoming-events.md --surface examples/agency/surface.json \
  --out upcoming-events.bundle.json examples/agency/builds/upcoming-events.json   # a verified customization as one file

# Compile with Claude (ANTHROPIC_API_KEY; default claude-opus-5-5): an A2UI surface.
pnpm graft compile examples/specs/review-queue.md \
  --surface hosts/wordpress/plugin/surfaces/7.1.json --out review-queue.build.json

# Upgrades
pnpm graft canary --corpus fixtures/canary/tenants \
  --from hosts/wordpress/plugin/surfaces/7.1.json --scenario move-row-actions   # or --to <surface.json>
pnpm surface:generate [--wp nightly] [--check]
pnpm surface:generate --site <mu-plugin.php> --name <site> --out-dir <dir>   # a site with its own content model

# A live site: WordPress (application password) or EmDash (API token with the admin scope)
pnpm graft site verify --site <url> --user <admin> --password <app password>
pnpm graft site pull --site <url> --user <admin> --password <app password> --out corpus/<tenant>
pnpm graft site install examples/emdash/specs/publish-queue.md examples/emdash/builds/publish-queue.json --site <url> --token <token>
pnpm graft site verify --site <url> --token <token>
```

## Tests

| Command | What |
| --- | --- |
| `pnpm typecheck`, `pnpm test` | Types and unit tests (core, A2UI, renderer, CLI, adapters) |
| `pnpm test:wp` | Plugin smoke test in Playground on PHP 7.4 and 8.4: abilities, store, lifecycle, gateway, host changes, security regressions |
| `pnpm verify:examples` | The example builds' checks in a WordPress sandbox |
| `pnpm verify:agency` | The agency example builds' checks, in a sandbox that reproduces the client site's content model |
| `pnpm test:compile` | The compile pipeline with a scripted model against WordPress: a wrong A2UI build is rejected in verification, the fix accepted |
| `pnpm test:canary` | Eight synthetic host changes, each forcing one rung, against a five-tenant corpus |
| `pnpm test:e2e` | Playwright in wp-admin: serving, gateway and its audit log, Dashboard widgets with local state, row actions, the publish checklist in the block editor, approval, authoring, `graft site` |
| `pnpm test:e2e:agency` | Playwright on a client site an agency built: custom post types, fields and terms, the agency's policy and managed customization, and upgrading after the agency changes the content model |
| `pnpm verify:emdash` | The EmDash example builds' checks in a throwaway EmDash |
| `pnpm test:compile:emdash` | The compile pipeline with a scripted model against EmDash, building an A2UI surface |
| `pnpm test:canary:emdash` | Six synthetic EmDash changes, each forcing one rung, against a two-tenant corpus |
| `pnpm test:site:emdash` | `graft site` against a live EmDash: install with local verification, verify drafts, pull into the canary |
| `pnpm test:emdash:sandboxed` | The same, with Graft in EmDash's plugin sandbox (workerd) |
| `pnpm test:author:emdash` | Writing a customization (an A2UI surface) in the EmDash admin, with a stubbed Claude API, natively and sandboxed |
| `pnpm test:cfworker` | The unit tests again on the schema engine used where code generation is forbidden |
| `pnpm test:packages` | The npm packages, packed as published, installed outside the workspace and imported |
| `pnpm test:emdash` | EmDash plugin smoke test: install, approve, serve per role, forged and refused actions, the status board's local state and actions |
| `pnpm test:e2e:emdash` | Playwright in the EmDash admin: the page, the widget and the editor panel |

CI runs all of them, plus a weekly canary against WordPress nightly. As of
7.2-alpha the surface is unchanged (same hash as 7.1) and every
customization re-passes its checks there.

## Design and status

Graft is a working prototype. All six MVP milestones of
[ADR 0001](docs/adr/0001-architecture.md) are built, and each is tested
against real WordPress in [Playground](https://wordpress.org/playground/).
Later decisions each have their own record:

| ADR | What |
| --- | --- |
| [0001](docs/adr/0001-architecture.md) | Specs, surfaces, builds, verification, compilation and the upgrade ladder |
| [0002](docs/adr/0002-authoring-and-operations.md) | Authoring in wp-admin, operating live sites, hardening |
| [0003](docs/adr/0003-emdash-host.md) | [EmDash](hosts/emdash/README.md) as a second host |
| [0004](docs/adr/0004-emdash-sandbox-and-authoring.md) | Graft in EmDash's plugin sandbox, and authoring in the EmDash admin |
| [0005](docs/adr/0005-sandboxed-functions.md) | Pure functions in QuickJS/WebAssembly where the declarative language runs out (superseded by 0009) |
| [0006](docs/adr/0006-interactive-widgets.md) | Interactive widgets that keep state, drawn with the host's components (superseded by 0009) |
| [0007](docs/adr/0007-editorial-tools.md) | Widgets that take input, and a panel in the block editor |
| [0008](docs/adr/0008-agency-sites.md) | Sites an agency builds: their own content model, policy and managed customizations |
| [0009](docs/adr/0009-a2ui.md) | A2UI surfaces as a build's UI, replacing trees |

Known limits:

- WordPress 7.1 or later.
- A site verifies its own builds. Signed verification records from a
  verifier outside the site are
  [future work](docs/adr/0002-authoring-and-operations.md#future-work).
- Each tenant gets its own copy of a spec. Specs that extend a shared
  template and follow its upgrades are not built yet.

## Layout

| Path | What |
| --- | --- |
| `docs/adr` | Architecture decision records |
| `schemas/` | JSON Schemas for spec, surface and build, and the spec lifecycle table |
| `packages/core` | Host-agnostic, no I/O: specs, surfaces, builds, expression evaluator, verifier, compiler, upgrade ladder, canary ([`@swissspidy/graft-core`](packages/core/README.md) on npm) |
| `packages/a2ui` | The A2UI format on `@a2ui/web_core`: the Graft catalog, validation, refs, snapshots, migrations and the compiler's UI phase ([`@swissspidy/graft-a2ui`](packages/a2ui/README.md) on npm) |
| `packages/renderer-react` | Loads a build's data through the capability gateway and runs its actions; the format's renderer draws it |
| `packages/cli` | The `graft` command |
| `hosts/wordpress` | The WordPress adapter: plugin, A2UI client, surface generator, sandbox, tests ([README](hosts/wordpress/README.md)) |
| `hosts/emdash` | The EmDash adapter: a native plugin that serves builds as Block Kit, surface, sandbox, test site, tests ([README](hosts/emdash/README.md)) |
| `examples/` | Example specs and their builds, A2UI surfaces (WordPress; EmDash in `examples/emdash`; an agency-built client site in `examples/agency`) |
| `fixtures/canary` | A multi-tenant corpus for the canary |

## Packages on npm

`@swissspidy/graft-core` and `@swissspidy/graft-a2ui` are published from
`packages/core` and `packages/a2ui`. In the workspace they export their
TypeScript sources; `pnpm build:packages` bundles each into `dist/` (ES
modules and type declarations), which is what `publishConfig.exports`
points the published packages at. The other packages stay private.

To release, set the same `version` in both package.json files, merge, and
publish a GitHub release tagged `v<version>`: the release workflow runs the
tests, checks the tag against the versions and stages both on npm with
provenance, authenticated by npm trusted publishing. A staged version goes
public once a maintainer approves it with 2FA, under Staged Packages on
npmjs.com or with `npm stage approve <stage-id>` (the run's summary lists
the IDs). The first release of
a new package is published by hand (`pnpm -r --filter "./packages/{core,a2ui}" publish --access public`),
since npm configures trusted publishing per existing package.

## License

Apache-2.0
