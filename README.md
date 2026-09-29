# Graft

Durable, spec-driven customizations for multi-tenant apps.

A customization is a short spec (intent, acceptance criteria, permissions)
stored per tenant. Graft compiles it into a declarative UI build for one
version of the host app, verifies the build against the acceptance criteria,
and when the host changes it migrates, re-anchors or regenerates the build
and verifies it again.

Status: milestones 1 to 5 of 6 (contracts, WordPress surface, runtime, verifier, compiler). Start with
[ADR 0001](docs/adr/0001-architecture.md) and the example specs:
[an admin page](examples/specs/review-queue.md) and
[an extension of the Posts screen](examples/specs/quick-approve.md).

## Layout

| Path             | What                                                        |
| ---------------- | ----------------------------------------------------------- |
| `schemas/`       | JSON Schemas for the three contracts: spec, surface, build. |
| `schemas/spec-lifecycle.json` | The spec version state machine, shared by the core and the plugin. |
| `packages/core`  | Host-agnostic core, no I/O: spec parser and validator, surface validation and hashing, build validation, refs, expression evaluator, lifecycle, the verifier (semantic snapshots and check runner over a host `Sandbox`) and the compiler (checks first, then a tree verified against them, with an injected model). |
| `packages/renderer-react` | Renders a build tree with React, given a host's components and capability gateway. |
| `packages/cli`   | The `graft` command: `validate`, `build`, `verify`, `compile` (Claude via the Anthropic SDK). |
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
pnpm verify:examples               # run the example builds' checks in a WordPress sandbox
pnpm test:compile                  # compile pipeline with a scripted model against WordPress

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
then log in at http://127.0.0.1:9400/wp-login.php as `editor`,
`contributor` or `subscriber` (password `password`) and open Posts → Review
queue.

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
