# WordPress host adapter

Everything Graft needs to target WordPress 7.1+.

| Path          | What                                                                                  |
| ------------- | ------------------------------------------------------------------------------------- |
| `plugin/`     | The `graft` plugin: abilities, the host half of the surface, the spec store, lifecycle, REST API, capability gateway and slot mounting. |
| `adapter/`    | TypeScript: the A2UI catalog for WordPress (`src/a2ui.ts`) and its renderer on a2ui-wp (`src/client`), ability schema normalization, surface generator, Playground driver. |
| `e2e/`        | Playwright tests of the runtime in wp-admin, against a seeded Playground.            |
| `plugin/surfaces/` | Generated surface snapshots, one per WordPress version. Checked in so host upgrades show up as diffs, and shipped with the plugin so it can tell which surface it runs on (by `fingerprint`). |
| `playground/` | Blueprint and scripts run inside WordPress Playground (surface dump, smoke test, e2e seed), and `sandbox/`, the verification endpoint. |

## Surface v0

- **Slots:** `admin.page` and `dashboard.widget` (owned), and
  `posts.list.row-actions` (extension slot on the Posts screen, anchored to
  the `post_row_actions` filter, provides the row's post).
- **UI:** builds are A2UI surfaces in the `graft:wordpress` catalog
  ([ADR 0009](../../docs/adr/0009-a2ui.md)); the catalog belongs to the
  adapter, not the surface.
- **Capabilities:** `posts.list` and `posts.update_status` (Graft
  abilities), `site.info` and `users.current` (core abilities). Builds only
  ever reference these names; the ability behind a name can change, and
  that change is a surface migration.
- **Scopes:** `posts:read`, `posts.status:write`, `site:read`,
  `users.current:read`, each with the WordPress capabilities it maps to.
- **Audiences:** the roles of a fresh install.

## Sites with their own content, and agencies

Sites built by an agency expose their own content, and the agency sets
what the site's administrators may do
([ADR 0008](../../docs/adr/0008-agency-sites.md)). Both are code (filters,
typically in a must-use plugin), never wp-admin settings:

- **`graft_content_model`**: post types customizations may use, with the
  custom fields (registered meta keys) and taxonomies of each. The surface
  carries the result as `model`. `posts.list` takes a `post_type`, a term
  filter and `meta.<field>` ordering. Posts come with `meta` and `terms`.
  Exposed fields and taxonomies add `posts.update_meta`,
  `posts.set_terms` and `terms.list`. The row-action and editor-panel
  slots take a `post_type` option. Default: posts (categories, tags) and
  pages.
- **`graft_policy`**: who maintains the site (`managed_by`, `contact`),
  whether its people may write customizations (`authoring`), which slots
  (`slots`) and permission scopes (`scopes`) they may use, and a directory
  of customization bundles the maintainer ships (`managed`, written by
  `graft bundle`). Those are installed, updated and archived with the
  code, and locked in wp-admin.

A site whose surface no shipped snapshot describes records its own from
Tools → Customizations: the admin's browser assembles it from the host
dump, and the plugin keeps it once it matches the site's fingerprint. The same screen upgrades customizations after a
content model change, verified in Playground in the browser.

The surface hash covers the contract only (not `hostVersion`, `previous`
or `migrations`), so WordPress versions that expose the same surface share
a hash and need no rebuild.

## Runtime

- **Store.** A private `graft_spec` post per spec (post name = spec id)
  with `graft_spec_version` children, one per immutable version: source,
  manifest, content hash, lifecycle state, grant, and builds keyed by
  surface hash. One site is one tenant. The manifest arrives already parsed
  by the TypeScript core (PHP has no YAML parser) and is re-validated
  against the surface on the server.
- **Lifecycle.** `schemas/spec-lifecycle.json`, copied into `plugin/build`
  by `pnpm build`. A verified build activates its version when the grant
  covers its scopes, otherwise the version waits for approval. A new
  version inherits the active version's grant, so unchanged permissions
  need no new approval. Unverified builds only move the state with
  `GRAFT_ALLOW_UNVERIFIED_BUILDS` (development), and are flagged.
- **Which surface.** The plugin computes a fingerprint of its host surface
  (structure only: no translated text, version or roles) and serves the
  builds for the shipped snapshot with the same fingerprint. An unknown
  surface serves nothing.
- **Gateway.** `POST /graft/v1/call {spec, capability, input}` is the only
  way a rendered build reaches data. It checks that the spec serves the
  current user (scope and audience), that the build uses the capability,
  and that the grant covers the capability's scopes, then runs the ability,
  whose own permission check applies on top.
- **Slots.** `admin.page` adds a menu page, `dashboard.widget` a widget,
  `posts.list.row-actions` a row action on the Posts screen with the row's
  post as slot props. The runtime (`plugin/build/runtime.js`) loads data
  through the gateway and `plugin/build/a2ui.js` draws the A2UI surface
  with a2ui-wp, using React and `@wordpress/components` from WordPress.
  The catalog's Table uses wp-admin list-table markup
  (`src/client/table.tsx`).
- **Admin screen.** Tools → Customizations (administrators) lists every
  spec with its state, the permissions it requests in plain language
  (granted or not), and each check rendered as a sentence next to the
  criterion it proves, with Approve, Decline, Archive and upgrade actions.
  Built from `adapter/src/client/admin.tsx` into `plugin/build/admin.js`.
- **Authoring.** "New customization" on the same screen opens a spec
  editor that validates against the site's surface as you type and
  compiles in the browser. Model requests go to `POST /graft/v1/generate`
  (administrators only), which answers through `wp_ai_client_prompt()`, so
  provider keys stay in the site's AI settings; the `graft_pre_generate`
  filter can answer instead (the e2e tests script it). Compiled builds are
  saved as drafts until they are verified, e.g. with `graft site verify`,
  which verifies them in a local sandbox and posts the result back. Needs a
  secure context (HTTPS or localhost) for hashing.
- **REST.** `GET /graft/v1/surface` (the site's current surface),
  `GET/POST /graft/v1/specs`,
  `POST /graft/v1/specs/<id>/versions/<n>/builds|approve|decline|archive`
  (administrators; users may create `user`-scoped specs).

## Verification

`graft verify` (or `verifyInWordPress()`) boots a throwaway Playground with
the plugin and the sandbox endpoint (`playground/sandbox/`, token-protected,
never shipped). For every check it resets the site, seeds the check's
fixtures, renders the build headlessly for the `view_as` user, with data
from real ability calls, performs the steps, and evaluates the
expectations over a semantic snapshot.

- **Fixtures:** `{ users: [{ as, role }], posts: [{ title, status, author? }] }`,
  where `author` is a user alias.
- **Expectations:** `rows` (primary labels of the table, any order),
  `columns`, `text`, `action` (with optional `row` matcher and
  `available`), and the host assertion `post` (`{ title, status }`).
- **Slot instances:** owned slots render once; `posts.list.row-actions`
  renders once per post in the Posts screen's "All" view for that user.
- **Snapshots** come from the A2UI format (`@swissspidy/graft-a2ui`), resolved with the
  same web_core and catalog the browser uses; table cells read as
  `adapter/src/cells.ts` formats them for both.

The grant is simulated as the spec's requested permissions, and the
gateway's checks (capability in the build, scopes granted) are applied as
in production.

## Upgrades

- Builds are stored per surface hash, so builds for the next WordPress can
  be attached before it is installed (`graft canary --out` writes them).
  Re-anchored builds may mount elsewhere than the spec says, and upgraded
  builds may need scopes beyond the grant: those are stored but not served
  until approved.
- On every admin and REST request the plugin compares its surface with the
  last one it saw (`graft_surface_hash`). On a change, active versions with
  a verified build for the new surface keep serving, those whose build
  needs a wider grant move to `needs_approval`, and the rest move to
  `upgrading` and are hidden until a build arrives (`upgraded`). Admins
  see a notice listing them. `upgrade_failed` and `retry` are available as
  REST events.
- The sandbox's `canary.php` mu-plugin applies synthetic host changes
  (renamed or removed capabilities, changed scopes, aliased and deprecated
  slots, an ability with a different input) through the plugin's surface
  filters, for the canary scenarios.

## Commands

Run from the repository root. Playground CLI is fetched on demand through
`npx` (pinned in `adapter/src/playground.ts`) and needs network access the
first time it downloads WordPress.

```sh
pnpm surface:generate               # boot WordPress 7.1, write surfaces/7.1.json
pnpm surface:generate --wp nightly  # any version Playground knows: 7.1, latest, beta, nightly
pnpm surface:generate --check       # fail if the plugin changed and the snapshot was not regenerated
pnpm build                          # bundle the client runtime into plugin/build
pnpm test:wp                        # smoke test abilities, store, lifecycle and gateway on WordPress 7.1 with PHP 7.4 and 8.4
pnpm test:e2e                       # Playwright against a seeded Playground (editor, contributor, subscriber)
pnpm verify:examples                # verify the example builds in a sandbox
pnpm surface:agency [--check]       # the agency example site's surface (surface:generate --site <mu-plugin>)
pnpm verify:agency                  # verify the agency example builds against it
pnpm bundle:agency                  # write the agency's managed customization bundle
pnpm test:e2e:agency                # Playwright on the agency example site (Riverside Arts Centre)
pnpm test:canary                    # run every canary scenario against fixtures/canary
pnpm graft validate --surface hosts/wordpress/plugin/surfaces/7.1.json examples/specs
```
