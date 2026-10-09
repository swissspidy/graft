# ADR 0002: Authoring in wp-admin, operating live sites, and hardening

- Status: Accepted
- Date: 2026-09-29
- Builds on: [ADR 0001](0001-architecture.md)

## Context

ADR 0001 got Graft to a working prototype: specs, surfaces, builds, a
runtime in wp-admin, a verifier, a compiler and the upgrade ladder, all
driven from a command line. Three things were missing for the people Graft
is for:

1. Writing a customization still meant a terminal and a checkout.
2. There was no way to operate on real sites: verify what an admin built
   there, or feed a site's customizations to the canary.
3. The plugin had not been reviewed as the security boundary it is.

## Decisions

### Authoring happens in wp-admin, the model call goes through the site

Tools → Customizations has a spec editor. It validates against the site's
own surface as the admin types (the snapshot is sent to the page), and
"Build it" runs the compiler from `packages/core` in the browser. Each
model request goes to `POST /graft/v1/generate`, which answers through
`wp_ai_client_prompt()->as_json_response()`. Provider keys stay in the
site's AI settings, and one compiler serves the CLI and wp-admin (the
answer to ADR 0001's open question 5).

The route is limited to administrators: model calls cost money and the
result is a site-wide customization. A `graft_pre_generate` filter lets
tests (and sites that want to route elsewhere) answer instead.

### Unverified builds are drafts; verification runs outside the live site

A build compiled in wp-admin is stored as a draft until it passes its
checks. Verification must never touch the live site's data, so it runs in
a throwaway WordPress:

- **In the admin's browser:** "Build it" starts WordPress Playground in a
  hidden iframe, installs this site's plugin from
  `GET /graft/v1/sandbox-package` (administrators only, without the browser
  bundles) and the sandbox endpoint, and runs each candidate's checks
  there. The sandbox protocol is transport-independent
  (`protocolSandbox`): the same operations go over HTTP to a Playground
  server from Node, or through `client.request()` in the browser.
  Playground's client ships with the plugin; the iframe loads remote.html
  (and with it WordPress and PHP) from playground.wordpress.net, or the
  Playground the `graft_playground_url` filter names. The
  `graft_browser_verification` filter turns it off.
- **From a terminal:** `graft site verify` fetches a site's unverified
  builds over REST (application password), runs their checks in a local
  Playground sandbox and posts the verification back. This covers sites
  where the browser can't run Playground.

Either way, the site then moves the version to "needs approval" (or
active, when the grant already covers it).

### Checks are reviewed in plain language

Admins approve permissions and checks, not JSON. Each check is rendered as
a sentence next to the criterion it proves (`describeCheck`, with host
describers). Criteria that cannot be checked objectively are sent back to
the author at compile time instead of getting a weak check (ADR 0001's open
question 2).

### Live sites are canary tenants

`graft site pull` exports a site's active customizations (spec, the build
for its current surface, and its grant) as a corpus tenant, so the canary
can run over real tenants, not just fixtures. A weekly CI job runs the
canary against WordPress nightly.

### Hardening the plugin

A security review of the plugin led to these rules:

- **Ownership.** Only administrators change shared (org, team) specs.
  People may create and version only their own personal specs. The stored
  scope decides, never the one in a request, and an id already used by a
  spec with another scope is refused.
- **Limits.** People who are not administrators get at most 10 personal
  specs and 25 versions per spec, and spec sources are capped at
  20,000 bytes.
- **Server-side validation.** Mounts are validated against their slot's
  option schema on the server. Menu titles are escaped (WordPress prints
  them as HTML).
- **Server-derived scopes.** The scopes a build needs are computed from the
  host's capability map (`build_scopes`), not taken from the build.
  Serving, approval and upgrade decisions all use them, and the gateway
  still checks each call.
- **Live builds stay verified.** An active version's served build can only
  be replaced by a verified one.

## Consequences

- A non-developer admin can go from an idea to a live, verified, approved
  customization without leaving wp-admin.
- Model output never reaches production without passing frozen checks and
  an explicit approval of its permissions.
- Verification records are still asserted by the admin-level client that
  uploads them. Anyone with `manage_options` can already change the site,
  so this does not widen trust. Signed verification (by a CI or a
  verification service), which would make "verified" provable, is planned
  for a future version.

## Future work

- **Signed verification.** A verifier outside the site signs the
  verification record (build hash, checks hash, surface hash, result), and
  the plugin accepts only signed records for active versions.
- **Template inheritance.** Tenant specs that extend a shared template and
  follow its upgrades, beyond copy-on-install (ADR 0001, question 4).
- **AI-assisted template migrations.** When a shared template changes,
  propose the change to each installed copy as a new spec version.
