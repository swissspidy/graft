# Graft

Durable, spec-driven customizations for multi-tenant apps.

A customization is a short spec (intent, acceptance criteria, permissions)
stored per tenant. Graft compiles it into a declarative UI build for one
version of the host app, verifies the build against the acceptance criteria,
and when the host changes it migrates, re-anchors or regenerates the build
and verifies it again.

Status: all six MVP milestones of ADR 0001 are implemented as a prototype (contracts, WordPress surface, runtime, verifier, compiler, upgrade ladder and canary). Start with
[ADR 0001](docs/adr/0001-architecture.md) and the example specs:
[an admin page](examples/specs/review-queue.md) and
[an extension of the Posts screen](examples/specs/quick-approve.md).

## Layout

| Path             | What                                                        |
| ---------------- | ----------------------------------------------------------- |
| `schemas/`       | JSON Schemas for the three contracts: spec, surface, build. |
| `schemas/spec-lifecycle.json` | The spec version state machine, shared by the core and the plugin. |
| `packages/core`  | Host-agnostic core, no I/O: spec parser and validator, surface validation and hashing, build validation, refs, expression evaluator, lifecycle, the verifier (semantic snapshots and check runner over a host `Sandbox`) and the compiler (checks first, then a tree verified against them, with an injected model), and the upgrade ladder and canary. |
| `packages/renderer-react` | Renders a build tree with React, given a host's components and capability gateway. |
| `packages/cli`   | The `graft` command: `validate`, `build`, `verify`, `compile` (Claude via the Anthropic SDK), `canary`. |
| `hosts/wordpress` | WordPress adapter: plugin, abilities, surface generator, surface snapshots. See [its README](hosts/wordpress/README.md). |
| `examples/specs` | Sample specs, also the future canary corpus.                |
| `examples/builds` | Hand-written builds of the sample specs for WordPress 7.1 (the compiler can produce these too). The three examples cover every slot: an admin page, a row action on the Posts screen and a Dashboard widget. |
| `fixtures/canary` | A multi-tenant corpus of customizations for the canary. |

## Development

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm test                          # unit tests
pnpm typecheck
pnpm graft validate examples/specs # validate spec files or directories
pnpm validate:examples             # ...and check them against the WordPress 7.1 surface
pnpm verify:examples               # run the example builds' checks in a WordPress sandbox
pnpm test:compile                  # compile pipeline with a scripted model against WordPress
pnpm test:canary                   # every synthetic host change against the corpus

# Upgrade the corpus ahead of a host change:
pnpm graft canary --corpus fixtures/canary/tenants \
  --from hosts/wordpress/plugin/surfaces/7.1.json --scenario move-row-actions

# Compile a spec with Claude (needs ANTHROPIC_API_KEY):
pnpm graft compile examples/specs/review-queue.md \
  --surface hosts/wordpress/plugin/surfaces/7.1.json --out review-queue.build.json
pnpm build                         # bundle the client runtime into the plugin
pnpm test:wp                       # smoke test the plugin in WordPress Playground
pnpm test:e2e                      # drive wp-admin in Chromium against a seeded Playground
pnpm surface:generate              # regenerate hosts/wordpress/plugin/surfaces/7.1.json
pnpm graft build examples/builds/review-queue.json \
  --surface hosts/wordpress/plugin/surfaces/7.1.json \
  --spec examples/specs/review-queue.md [--fix-refs]
```

To click around yourself: `pnpm build && tsx hosts/wordpress/e2e/server.ts`,
then log in at http://127.0.0.1:9400/wp-login.php as `admin`, `editor`,
`contributor` or `subscriber` (password `password`). Editors find Posts →
Review queue and the Approve row action; admins find Tools → Customizations,
where "Waiting for review" waits for approval before it appears on the
Dashboard.

## License

Apache-2.0

## Compiling

`graft compile` turns a spec into a verified build in two phases:

1. **Checks.** Claude turns the acceptance criteria into executable checks
   without seeing any implementation. They are frozen from then on.
2. **Tree.** Claude builds the tree and data sources against the frozen
   checks. Each candidate is validated against the surface and spec and
   verified in a WordPress sandbox; problems go back to the model until it
   passes or the attempts run out (3 per phase by default).

Output is constrained with structured outputs (the tree comes back as a flat
node list with component and capability names limited to the surface), the
system prompt is cached across attempts, and refusals fall back server-side
(`fallbacks: "default"`). The default model is `claude-opus-5-5` at `high`
effort. `--previous <build>` regenerates a build for a changed host while
reusing its frozen checks.

## Upgrading

When the host changes, each active build goes up a ladder until one
candidate passes its frozen checks on the new host:

| Rung | When | Outcome |
| --- | --- | --- |
| reverify | nothing the build uses changed | survived |
| migrate | every change has a declared migration (renames) | migrated |
| re-anchor | only the mount point moved (a deprecated slot's successor, or the one compatible slot) | re-anchored |
| regenerate | anything else: recompile with the frozen checks and the old build as reference | regenerated |

A candidate that needs a scope outside the grant exits as *needs approval*
(verified with the wider grant, so it works once approved). If nothing
passes, the outcome is *failed*.

`graft canary` runs the ladder for every tenant's customizations ahead of
the upgrade, sharing results between identical customizations, and writes
the upgraded builds. The plugin stores builds per surface hash: when the
host's surface actually changes, versions with a prepared build keep
serving, those that need a wider grant wait for approval, and the rest are
hidden (and flagged to admins) until a build for the new surface arrives.

`pnpm test:canary` proves each rung against a real WordPress: synthetic
host changes are applied inside the sandbox through the plugin's surface
filters (`hosts/wordpress/playground/sandbox/canary.php`), and the new
surface is generated from that patched host like any other snapshot.
