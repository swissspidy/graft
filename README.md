# Graft

Durable, spec-driven customizations for multi-tenant apps.

A customization is a short spec (intent, acceptance criteria, permissions)
stored per tenant. Graft compiles it into a declarative UI build for one
version of the host app, verifies the build against the acceptance criteria,
and when the host changes it migrates, re-anchors or regenerates the build
and verifies it again.

Status: milestones 1 (contracts), 2 (WordPress surface v0) and 3 (runtime) of 6. Start with
[ADR 0001](docs/adr/0001-architecture.md) and the example specs:
[an admin page](examples/specs/review-queue.md) and
[an extension of the Posts screen](examples/specs/quick-approve.md).

## Layout

| Path             | What                                                        |
| ---------------- | ----------------------------------------------------------- |
| `schemas/`       | JSON Schemas for the three contracts: spec, surface, build. |
| `schemas/spec-lifecycle.json` | The spec version state machine, shared by the core and the plugin. |
| `packages/core`  | Host-agnostic core, no I/O: spec parser and validator, surface validation and hashing, build validation, refs, expression evaluator, lifecycle. |
| `packages/renderer-react` | Renders a build tree with React, given a host's components and capability gateway. |
| `packages/cli`   | The `graft` command: `graft validate`, `graft build`.       |
| `hosts/wordpress` | WordPress adapter: plugin, abilities, surface generator, surface snapshots. See [its README](hosts/wordpress/README.md). |
| `examples/specs` | Sample specs, also the future canary corpus.                |
| `examples/builds` | Hand-written builds of the sample specs for WordPress 7.1 (the compiler replaces these in milestone 5). |

## Development

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm test                          # unit tests
pnpm typecheck
pnpm graft validate examples/specs # validate spec files or directories
pnpm validate:examples             # ...and check them against the WordPress 7.1 surface
pnpm build                         # bundle the client runtime into the plugin
pnpm test:wp                       # smoke test the plugin in WordPress Playground
pnpm test:e2e                      # drive wp-admin in Chromium against a seeded Playground
pnpm surface:generate              # regenerate hosts/wordpress/plugin/surfaces/7.1.json
pnpm graft build examples/builds/review-queue.json \
  --surface hosts/wordpress/plugin/surfaces/7.1.json \
  --spec examples/specs/review-queue.md [--fix-refs]
```

To click around yourself: `pnpm build && tsx hosts/wordpress/e2e/server.ts`,
then log in at http://127.0.0.1:9400/wp-login.php as `editor`,
`contributor` or `subscriber` (password `password`) and open Posts → Review
queue.

## License

Apache-2.0
