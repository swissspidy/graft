# WordPress host adapter

Everything Graft needs to target WordPress 7.1+.

| Path          | What                                                                                  |
| ------------- | ------------------------------------------------------------------------------------- |
| `plugin/`     | The `graft` plugin: abilities (`graft/posts-list`, `graft/post-update-status`) and the host half of the surface (slots, scopes, capability map). |
| `adapter/`    | TypeScript: component registry, ability schema normalization, surface generator, Playground driver. |
| `surfaces/`   | Generated surface snapshots, one per WordPress version. Checked in so host upgrades show up as diffs. |
| `playground/` | Blueprint and scripts run inside WordPress Playground (surface dump, smoke test).     |

## Surface v0

- **Slots:** `admin.page` and `dashboard.widget` (owned), and
  `posts.list.row-actions` (extension slot on the Posts screen, anchored to
  the `post_row_actions` filter, provides the row's post).
- **Components:** `stack`, `heading`, `text`, `button`, `notice`, `card`,
  `empty-state`, `table` (DataViews) and `row-action`. Prop schemas
  describe values after bindings resolve; actions (`$call`) and conditions
  (`$can`) stay expressions for the renderer to evaluate.
- **Capabilities:** `posts.list` and `posts.update_status` (Graft
  abilities), `site.info` and `users.current` (core abilities). Builds only
  ever reference these names; the ability behind a name can change, and
  that change is a surface migration.
- **Scopes:** `posts:read`, `posts.status:write`, `site:read`,
  `users.current:read`, each with the WordPress capabilities it maps to.
- **Audiences:** the roles of a fresh install.

The surface hash covers the contract only (not `hostVersion`, `previous`
or `migrations`), so WordPress versions that expose the same surface share
a hash and need no rebuild.

## Commands

Run from the repository root. Playground CLI is fetched on demand through
`npx` (pinned in `adapter/src/playground.ts`) and needs network access the
first time it downloads WordPress.

```sh
pnpm surface:generate               # boot WordPress 7.1, write surfaces/7.1.json
pnpm surface:generate --wp nightly  # any version Playground knows: 7.1, latest, beta, nightly
pnpm surface:generate --check       # fail if the plugin changed and the snapshot was not regenerated
pnpm test:wp                        # smoke test the abilities on WordPress 7.1 with PHP 7.4 and 8.4
pnpm graft validate --surface hosts/wordpress/surfaces/7.1.json examples/specs
```
