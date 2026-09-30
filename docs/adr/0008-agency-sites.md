# ADR 0008: Sites an agency builds: content models, site surfaces and policy

- Status: Accepted (WordPress)
- Date: 2026-09-30
- Builds on: [ADR 0001](0001-architecture.md), [ADR 0002](0002-authoring-and-operations.md)

## Context

Many WordPress sites are built by an agency and then run by the client.
Weeks or months later, the client wants small changes to how they work:
which events are missing a venue, a one-click "family friendly" on the
events list, a checklist before a job listing goes live. Today each of
those is a support ticket.

Graft could answer them, but it only knew WordPress as it ships: posts,
their title, excerpt and status. Agency sites are mostly their own post
types, custom fields and taxonomies. The agency also has a stake of its
own. It wants to decide how far the client can go, to ship customizations
it maintains itself, and to keep everything working when it deploys a
change to the site.

Three things stood in the way:

1. Customizations could not see or change a site's own content.
2. A site's surface can only be one that ships with the plugin, so a site
   that exposes its own content has no surface and serves nothing.
3. There was no way for the people who maintain a site's code to limit or
   manage what its administrators do with Graft.

## Decisions

### The site's code decides what content Graft sees

The `graft_content_model` filter lists the post types customizations may
use, with the custom fields (meta keys) and taxonomies of each:

```php
add_filter( 'graft_content_model', function ( array $exposed ): array {
	$exposed['event'] = array(
		'fields'     => array( 'event_date', 'venue', 'capacity', 'sold_out' ),
		'taxonomies' => array( 'event_type' ),
	);
	return $exposed;
} );
```

It is a filter, not a setting, so the choice lives with the code that
registers the post types, and an administrator cannot widen it. Everything
else comes from WordPress's registries: labels, whether the block editor
edits the type, its capability type, and each field's JSON Schema. The
schema is built from `register_post_meta()`: the type, and the
constraints `show_in_rest` declares. Only fields registered as single
strings, integers, numbers or booleans are exposed, and only taxonomies
registered for the type. Fields that are not exposed stay invisible, even
on an exposed type. By default, posts (with categories and tags) and pages
are exposed.

The result is the surface's new `model` section. It is part of the
contract, so it is hashed. The rest of the surface follows from it:

- `posts.list` takes an exposed `post_type`, a `term` filter and
  `meta.<field>` ordering. Each post comes with `meta` (typed values, null
  when unset) and `terms` (per taxonomy, `{id, name, slug}`).
- New capabilities:
  - `posts.update_meta` (new scope `posts.meta:write`);
  - `posts.set_terms`, which replaces, adds or removes terms by slug (new
    scope `posts.terms:write`);
  - `terms.list` (scope `posts:read`).

  Each is registered only when the site exposes fields or taxonomies.
- The row-action and editor-panel slots take a `post_type` option and
  provide the post's `meta` and `terms`.
- Abilities refuse posts of types that are not exposed. `posts.update_meta`
  also checks WordPress's own `edit_post_meta` for each field. WordPress
  sanitizes each value with the callback the field was registered with.

### Verification reproduces the site's content model

A build for a site with events has checks with events in them, and the
verifier's throwaway WordPress has no events. The verifier now calls the
sandbox's new `prepare(surface)` before running a build's checks. The
WordPress sandbox registers the surface's model there: post types,
taxonomies and fields (`playground/sandbox/model.php`). It exposes them to
Graft like the site does. Fixtures seed fields and terms, slot instances
follow the mount's post type, and the `post` assertion compares fields and
terms.

This reproduces the model, not the site. A post type with its own
capability type gets those capabilities on every role that has the
matching post capabilities, and fields get the default permission check.
Checks therefore prove what a customization does with the content, not
how the site's own permission code behaves.

### A site records its own surface

A site that exposes its own content has a surface no shipped snapshot
describes, and builds are only served for a known surface. Only the
TypeScript core normalizes and hashes surfaces, and the admin screen
already runs the core in the browser. So Tools → Customizations assembles
the site's surface from the plugin's host dump (`GET
/graft/v1/host-surface`), with the same code that generates the shipped
snapshots. It then stores the surface (`POST /graft/v1/surfaces`).

The plugin accepts it only if:

- its fingerprint is the host's own;
- it carries the plugin's own components and function limits.

A site surface can therefore only differ from a shipped one in what the
host itself exposes. The plugin keeps the three newest.

Surfaces are content-addressed, so a site surface that happens to equal a
shipped snapshot has the same hash. `graft site verify` fetches a site's
surfaces too. This also covers a WordPress version the plugin has no
snapshot for yet: before, nothing was served.

### Customizations are carried over in the browser

When the content model changes, the surface changes, and the customizations
built for the old one stop being served. This is the same as after a
WordPress update. Tools → Customizations now offers **Check and upgrade**
for them. It runs the upgrade ladder in the browser, verifies each
candidate in Playground there, and attaches the builds that pass.

Most changes an agency deploys add something: a new field, a new type, a
new term filter. Before, the static check treated any schema change as
breaking and started the ladder at *regenerate*. It now knows which
changes are compatible. An input schema may accept more: new optional
properties, wider enums and types. An output or slot schema may provide
more, but not less. A compatible change starts at *reverify*: the build's
checks still run unchanged, and anything else escalates as before.

### The agency's policy

The `graft_policy` filter says who maintains the site, and what its
administrators may do:

| Key | Meaning |
| --- | --- |
| `managed_by` | Who maintains the site, shown in wp-admin |
| `contact` | Where to ask for more |
| `authoring` | Whether the site's own people may write customizations |
| `slots` | Slots their customizations may use |
| `scopes` | Permission scopes their administrators may approve |
| `managed` | Directory of the maintainer's own customizations |

The policy is enforced on the server:

- when a spec version is created;
- when a version is approved, both for what the spec requests and for what
  its build needs;
- when the model proxy is used, which requires `authoring`.

Tools → Customizations shows the policy in plain language. The policy only
narrows: it never lets anyone do more than WordPress allows.

### Managed customizations are bundles shipped with the code

`graft bundle` writes one customization as a file: the spec, the manifest
parsed from it (the plugin has no YAML parser), and its builds, each
verified in a sandbox first. The plugin syncs the bundles in the policy's
`managed` directory whenever their files, the policy or the surface change:

- new bundles are installed;
- changed ones become new versions;
- ones whose file is gone are archived.

The maintainer's verification and grant are trusted, because they come
with the code, as the plugin itself does. Managed customizations are
marked "Managed by …" and cannot be approved, declined, archived or
replaced from wp-admin. Builds can still be attached to them, so a site
can carry them over after a change.

The bundle is also the unit for sharing a customization between sites
(not built yet). Personal customizations (`scope: user`) already exist in
the store, so people could later share theirs with colleagues the same
way.

## Example

`examples/agency` is a client site an agency built:

- The site: the Riverside Arts Centre (`playground/sites/riverside.php`).
  It has events with a date, venue, seats and a sold-out flag, and event
  types.
- Its surface: `surface:agency`.
- Its agency, Lumen Studio: allows Dashboard widgets, row actions and
  editor panels, and allows changing fields and terms, but not publishing.
- Two customizations:
  - **Upcoming events**, which Lumen Studio manages: a Dashboard widget of
    events soonest first, with venue and seats, a "Venue missing" error,
    and a "Mark sold out" action that writes a field (4 checks);
  - **Family friendly**, the centre's own: a row action on the Events
    screen that adds the Family type (5 checks).

`pnpm test:e2e:agency` runs it end to end:

- the policy and the managed customization in wp-admin;
- the widget's fields and write;
- the policy's refusals;
- approving and using Family friendly;
- after the agency deploys a release that exposes another field: recording
  the new surface and carrying both customizations over in the browser.

## Consequences

- Customizations can work with a site's own content, within what its code
  exposes. The expression language still has no "contains"; testing for a
  term takes a pure function.
- Each client site with its own content model has its own surface. An
  agency can generate it (`surface:generate --site <mu-plugin>`), verify
  and bundle builds against it, and run the canary for each client before
  a WordPress update.
- Changing the content model hides customizations until an administrator
  opens Tools → Customizations and upgrades them, which needs Playground in
  the browser. Upgrading on the server at deploy time is still not
  implemented. In the browser, the ladder stops before *regenerate*.
- The sandbox's model is an approximation. Checks do not prove the site's
  own permission callbacks.
- The policy is only as strong as the site's code. An administrator who
  can edit plugins can change it, which is expected.
- Sharing, per-user customizations shared between people, and
  notifications are left for later. The bundle format is the starting
  point.
