# WordPress host adapter

Everything Graft needs to target WordPress 7.1+.

| Path          | What                                                                                  |
| ------------- | ------------------------------------------------------------------------------------- |
| `plugin/`     | The `graft` plugin: abilities, the host half of the surface, the spec store, lifecycle, REST API, capability gateway and slot mounting. |
| `adapter/`    | TypeScript: component registry and their WordPress implementations (`src/client`), ability schema normalization, surface generator, Playground driver. |
| `e2e/`        | Playwright tests of the runtime in wp-admin, against a seeded Playground.            |
| `plugin/surfaces/` | Generated surface snapshots, one per WordPress version. Checked in so host upgrades show up as diffs, and shipped with the plugin so it can tell which surface it runs on (by `fingerprint`). |
| `playground/` | Blueprint and scripts run inside WordPress Playground (surface dump, smoke test, e2e seed), and `sandbox/`, the verification endpoint. |

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
  post as slot props. The client bundle (`plugin/build/runtime.js`, about
  10 KB) uses React and `@wordpress/components` from WordPress. The
  `table` component uses wp-admin list-table markup for now; its props are
  DataViews-shaped, so moving it to DataViews is a change inside the
  wrapper, not the surface.
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
- **Semantics** (`adapter/src/semantics.ts`) say how each component reads in
  a snapshot and must follow `src/client/components.tsx`.

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
pnpm test:canary                    # run every canary scenario against fixtures/canary
pnpm graft validate --surface hosts/wordpress/plugin/surfaces/7.1.json examples/specs
```
