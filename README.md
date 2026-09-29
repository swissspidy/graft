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

The design is in [ADR 0001](docs/adr/0001-architecture.md). The first host is
WordPress 7.1+ (wp-admin); the core is host-agnostic.

Status: a working prototype. All six MVP milestones of the ADR are built, and
each is tested against real WordPress in [Playground](https://wordpress.org/playground/).

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
the existing Posts screen, and a Dashboard widget.

## How it works

**Build.** A build is data, not code: a tree of components the host
declares (table, button, notice, ...), bindings into data sources, and
actions that call the host's capabilities (WordPress abilities). A trusted
renderer draws it with native wp-admin components. It also carries
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
tree against them; each candidate is validated against the host's surface
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
   **Build it**. The compiler runs in the browser; model requests go through
   the site's WordPress AI client, so provider keys never reach the browser.
2. The build is saved as a draft until it is verified:
   `graft site verify --site <url> --user <admin> --password <application password>`
   runs its checks in a local WordPress sandbox and sends the result back.
3. The administrator reviews the permissions and every check in plain
   language, next to the criterion it proves, and approves it.

Verifying inside the admin's browser (Playground in an iframe) would remove
step 2's CLI; it is not built yet.

## Try it

Requires Node 22+ and pnpm. Playground is fetched on demand (network access
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

## Commands

```sh
# Specs and builds
pnpm graft validate --surface hosts/wordpress/plugin/surfaces/7.1.json examples/specs
pnpm graft build examples/builds/review-queue.json \
  --surface hosts/wordpress/plugin/surfaces/7.1.json --spec examples/specs/review-queue.md [--fix-refs]
pnpm graft verify --surface hosts/wordpress/plugin/surfaces/7.1.json --spec examples/specs examples/builds/*.json

# Compile with Claude (ANTHROPIC_API_KEY; default claude-opus-5-5)
pnpm graft compile examples/specs/review-queue.md \
  --surface hosts/wordpress/plugin/surfaces/7.1.json --out review-queue.build.json

# Upgrades
pnpm graft canary --corpus fixtures/canary/tenants \
  --from hosts/wordpress/plugin/surfaces/7.1.json --scenario move-row-actions   # or --to <surface.json>
pnpm surface:generate [--wp nightly] [--check]

# A live site (application password)
pnpm graft site verify --site <url> --user <admin> --password <app password>
pnpm graft site pull --site <url> --user <admin> --password <app password> --out corpus/<tenant>
```

## Tests

| Command | What |
| --- | --- |
| `pnpm typecheck`, `pnpm test` | Types and unit tests (core, renderer, CLI, adapter) |
| `pnpm test:wp` | Plugin smoke test in Playground on PHP 7.4 and 8.4: abilities, store, lifecycle, gateway, host changes, security regressions |
| `pnpm verify:examples` | The example builds' checks in a WordPress sandbox |
| `pnpm test:compile` | The compile pipeline with a scripted model against WordPress |
| `pnpm test:canary` | Six synthetic host changes, each forcing one rung, against a four-tenant corpus |
| `pnpm test:e2e` | Playwright in wp-admin: serving, gateway, approval, authoring, `graft site` |

CI runs all of them, plus a weekly canary against WordPress nightly. As of
7.2-alpha the surface is unchanged (same hash as 7.1) and every
customization re-passes its checks there.

## Layout

| Path | What |
| --- | --- |
| `docs/adr` | Architecture decision records |
| `schemas/` | JSON Schemas for spec, surface and build, and the spec lifecycle table |
| `packages/core` | Host-agnostic, no I/O: specs, surfaces, builds, expression evaluator, verifier, compiler, upgrade ladder, canary |
| `packages/renderer-react` | Renders a build with a host's components and capability gateway |
| `packages/cli` | The `graft` command |
| `hosts/wordpress` | The WordPress adapter: plugin, components, surface generator, sandbox, tests ([README](hosts/wordpress/README.md)) |
| `examples/` | Example specs and hand-written builds |
| `fixtures/canary` | A multi-tenant corpus for the canary |

## License

Apache-2.0
