# Canary corpus

Tenants (one directory each) with their active customizations: a spec file
and the build currently served for it. `daily-news` and `campus-blog` run
the identical review queue, so the canary upgrades it once and shares the
result; `agency` runs its own variant (`editorial-inbox`).

Used by `pnpm test:canary`, which runs every synthetic scenario in
`hosts/wordpress/adapter/src/canary.ts` against this corpus.
