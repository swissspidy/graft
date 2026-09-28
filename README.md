# Graft

Durable, spec-driven customizations for multi-tenant apps.

A customization is a short spec (intent, acceptance criteria, permissions)
stored per tenant. Graft compiles it into a declarative UI build for one
version of the host app, verifies the build against the acceptance criteria,
and when the host changes it migrates, re-anchors or regenerates the build
and verifies it again.

Status: design. Start with [ADR 0001](docs/adr/0001-architecture.md) and the
[example spec](examples/specs/review-queue.md).
