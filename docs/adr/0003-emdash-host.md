# ADR 0003: EmDash as the second host

- Status: Accepted
- Date: 2026-09-29
- Builds on: [ADR 0001](0001-architecture.md), [ADR 0002](0002-authoring-and-operations.md)

## Context

ADR 0001 claims the core is host-agnostic, but only WordPress used it. A
second host tests that claim. We picked [EmDash](https://github.com/emdash-cms/emdash)
(Cloudflare's TypeScript CMS on Astro, 1.0.1 at the time) over Ghost and
over a SaaS-style app of our own:

- Its admin draws declarative UI for plugins (**Block Kit**), which is what
  a Graft build is. Ghost's admin has no extension points at all.
- Plugins declare capabilities and EmDash enforces them, much like Graft's
  scopes and grants.
- It is TypeScript, so the core, verifier and compiler run inside the
  plugin as they are.
- It is young and changes fast: good material for the upgrade ladder.

A spike confirmed it runs on plain Node with SQLite, from npm, without
Cloudflare. It also showed the limits of its extension points (below).

## Decisions

### A native plugin renders builds as Block Kit on the server

The Graft plugin (`hosts/emdash/adapter/src/plugin`) runs in the host
process. For each request it renders the active builds for the viewer on
the server and returns Block Kit, which the EmDash admin draws with its own
components. No Graft code runs in the browser. On WordPress, by contrast, a
trusted React renderer runs in wp-admin.

A click comes back as a Block Kit `block_action` carrying only an action
id and a row id. The plugin renders the build again from fresh data and
looks for an available button with that id and value. Only then does it
run that button's `$call`. The browser therefore never names a capability
or its input, and a button the viewer was not shown (another role's, or a
row that is gone) does nothing. The gateway runs in-process: the build must
use the capability, the grant must cover its scopes, and the input must
match its schema. Then EmDash's own RBAC applies to the viewer. There is no
public call endpoint.

### Slots map onto the extension points EmDash has

| Graft slot | EmDash | Notes |
| --- | --- | --- |
| `admin.page` (owned) | A tab on the plugin's one **Customizations** page | EmDash only serves plugin pages declared at build time, so customizations cannot add pages of their own. Administrators also get a **Manage** tab. |
| `dashboard.widget` (owned) | A section of the plugin's one dashboard widget | Widgets are declared at build time too. |
| `content.editor.panel` (extension) | A section of the plugin's panel in the entry editor sidebar | Receives the saved entry as `entry`. |

EmDash has no equivalent of WordPress's `posts.list.row-actions`. Only
trusted React plugins can add columns to the content list, those columns
are read-only, and no plugin can add row actions. The closest thing is the
editor panel. Editor toolbar actions exist, but they are not a slot yet.

### Components are Block Kit, and snapshots come from the translation

The components (`header`, `section`, `context`, `banner`, `fields`,
`stats`, `empty`, `table` with per-row buttons, `actions`, `button`,
`divider`, and `stack` as the root) are Block Kit shaped. The verifier's
semantics are derived from the same per-node translation the plugin sends
to the admin (`nodeOutput`), so the verifier reads exactly what people
see.

### Scopes map to EmDash permissions

| Scope | EmDash permissions | Capabilities |
| --- | --- | --- |
| `content:read` | `content:read_drafts` | `content.list`, `content.get` |
| `content.status:write` | `content:publish_own`, `content:publish_any` | `content.publish`, `content.unpublish` |

Checks go through `@emdash-cms/auth` (`hasPermission`, `canActOnOwn`).
Entries carry `can.publish` for the viewer, and `$can` uses it, as with
WordPress's per-post flags.

### Store, lifecycle and approval

Specs and their versions live in the plugin's KV and follow the shared
lifecycle table. Only administrators install (`POST
/_emdash/api/plugins/graft/install`, with the spec, the build and its
verification) and approve (in the Manage tab or through the `approve`
route). A build goes live only when its verification passed for this spec
version and this surface. If it needs scopes outside the grant, it waits
for approval. The scopes a build needs are derived from its content, as on
WordPress. Audience is a visibility rule, as before.

### Verification in a throwaway EmDash

The sandbox is the same plugin with a `sandbox` route (option
`sandbox: true`, set from `GRAFT_SANDBOX=1` by the test site). It runs in
`astro dev` on a fresh SQLite database, and a Node driver speaks the same
protocol as the WordPress sandbox. Fixture users are role-only viewers
rather than accounts: EmDash decides permissions from the role and, for
"own" permissions, from the entry's author. Entries the sandbox creates
have no author, so authors cannot publish them. The compiler's host guide
says so. The browser tests use real accounts through a test-only login on
the test site, because EmDash's real sign-in needs passkeys.

### The surface is declared by the adapter

`src/host/surface.ts` declares slots, components, capabilities and scopes.
`hostVersion` comes from EmDash's `package.json`. The hash leaves the
version out, so a new EmDash only changes it when what builds can use
changes. The snapshot is `hosts/emdash/adapter/surfaces/1.0.json`.

## Consequences

- **The core needed no changes.** Specs, builds, the expression language,
  the verifier, the compiler and the upgrade ladder took EmDash as they
  were. Only the CLI learned to pick a host adapter from the surface
  (`packages/cli/src/hosts.ts`).
- The same kind of customization (a publish queue, a drafts widget)
  compiles to either host from nearly the same spec. What differs is each
  host's vocabulary: statuses, roles and slots.
- **Server-side rendering is stateless**, so every `then` re-renders from
  fresh data, and `remove-row` has the same effect as `refresh`. The
  verifier still simulates `remove-row` without reloading. EmDash builds
  should use `refresh:<source>`, and the host guide says so.
- One page, one widget and one panel hold every customization. That is
  cruder than WordPress's menu items, but it is what EmDash allows today.
- The canary works on EmDash too. The sandbox can apply a synthetic host
  change (`src/host/patch.ts`: rename, remove or re-scope a capability,
  change an input, move a slot) to the surface it reports and to the calls
  it runs. Six scenarios each force one rung of the ladder
  (`pnpm test:canary:emdash`).
- Not done yet for EmDash:
  - `graft site` against a live EmDash;
  - authoring in its admin;
  - the sandboxed plugin format (needed for installs from EmDash's
    registry);
  - editor actions as a slot.
