# Graft

Durable, spec-driven customizations for multi-tenant apps.

A customization is a short spec (intent, acceptance criteria, permissions)
stored per tenant. Graft compiles it into a declarative UI build for one
version of the host app, verifies the build against the acceptance criteria,
and when the host changes it migrates, re-anchors or regenerates the build
and verifies it again.

Status: milestone 1 of 6 (contracts). Start with
[ADR 0001](docs/adr/0001-architecture.md) and the example specs:
[an admin page](examples/specs/review-queue.md) and
[an extension of the Posts screen](examples/specs/quick-approve.md).

## Layout

| Path             | What                                                        |
| ---------------- | ----------------------------------------------------------- |
| `schemas/`       | JSON Schemas for the three contracts: spec, surface, build. |
| `packages/core`  | Host-agnostic core, no I/O. Today: spec parser and validator. |
| `packages/cli`   | The `graft` command. Today: `graft validate`.               |
| `examples/specs` | Sample specs, also the future canary corpus.                |

## Development

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm test                          # unit tests
pnpm typecheck
pnpm graft validate examples/specs # validate spec files or directories
```

## License

Apache-2.0
