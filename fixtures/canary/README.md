# Canary corpus

Tenants (one directory each) with their active customizations: a spec file
and the build currently served for it. `daily-news` and `campus-blog` run
the identical review queue, so the canary upgrades it once and shares the
result; `agency` runs its own variant (`editorial-inbox`).

Every build is an A2UI surface. `editorial-inbox` was a tree: it was
regenerated from its spec and frozen checks (`graft compile --previous`),
in the host's format, as the upgrade ladder's regenerate rung does.

Used by `pnpm test:canary`, which runs every synthetic scenario in
`hosts/wordpress/adapter/src/canary.ts` against this corpus.

`emdash/` is the same for EmDash: `newsroom` runs all three EmDash
examples, and `studio` runs the identical publish queue and drafts widget.
Used by `pnpm test:canary:emdash` (scenarios in
`hosts/emdash/adapter/src/node/canary.ts`).
