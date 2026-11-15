# ADR 0015: A website as a host, for experiments that change a site's source

- Status: Accepted (implemented in [the lab](https://github.com/swissspidy/lab))
- Date: 2026-11-15
- Builds on: [ADR 0001](0001-architecture.md), [ADR 0011](0011-browser-extension-host.md)

## Context

The lab is an open-source loop that improves a live website one
experiment at a time and never ships an unverified change. Each experiment
has a spec: what changes, criteria for how we know it worked, and checks
for those criteria written before the change exists. That is a Graft spec
in all but name, and the lab's specs were already written in Graft's
Markdown format and read with Graft's parser.

They could not be validated by Graft, though. Graft's frontmatter schema
is closed and requires a host, a mount slot and permission scopes, and
the lab had no host, kept its own fields under an extra `lab:` key, and
limited a variant only by allow and deny lists in its config. The
questions were:

1. What are a website's slots and scopes, and where do they come from?
2. Where do the lab's own fields go, without widening Graft's schema?
3. What does Graft check, and what stays with the lab?

## Decisions

### Host `website`; its surface comes from the site

A website is host `website`. Its surface is generated from the site, as
WordPress's comes from its registries:

- **Slots.** One for the whole site (`site`: navigation, layout, global
  styles) and one per page (`page.index`, `page.docs`,
  `page.docs.intro`). Pages are the ones the lab verifies: the site's
  configured routes, or the HTML files its build writes. Every slot is an
  `extension` slot: an experiment changes what is there.
- **Scopes.** Kinds of files a variant may change: `markup:write` (HTML
  and components), `style:write` (stylesheets), `content:write` (Markdown,
  JSON, YAML), `script:write` (JavaScript and TypeScript modules) and
  `asset:write` (SVG). A site offers a scope only if the files its config
  lets variants change include at least one of that kind. A scope's `host`
  field lists the file extensions it covers.
- **No capabilities.** A variant is a patch to the site's source that the
  lab builds, verifies and serves to a share of visitors. It does not call
  the host at run time, so there is nothing for a gateway to mediate.

The surface depends on the pages, which are known only once the baseline
is built, so the lab generates it then, for each experiment.

### The lab's fields are sections, not frontmatter

An experiment spec's frontmatter is plain Graft and passes Graft's schema
as is:

~~~markdown
---
graft: 1
id: exp-0007
host: website
mount: { slot: site }
permissions: [markup:write]
---
# Add a Docs link to the main navigation.

Add a Docs link to the main navigation.

## Acceptance criteria

- The main navigation links to the docs. {#c0}

## Hypothesis

Visitors who want the docs do not find them from the home page.

## Expected effect

next_step_click up

## Touches

- src/components/header.html

## Source

agent

## Checks

```json
[{ "criterion": 0, "page": "index.html", "expect": [{ "expect": "visible", "target": { "css": "nav a[href=\"docs.html\"]" } }] }]
```
~~~

Hypothesis, expected effect, touches, source and checks are `##` sections.
Graft keeps sections it does not know and passes them to the compiler as
context. It does not interpret them, so the schema stays closed and no
other host is affected.

### Graft validates the spec; the lab enforces it on the patch

Graft does what it does for every host, through the published
`validateSpec`:

- Phase one, whenever a spec is read: the frontmatter schema.
- Phase two, once the surface exists: the mount slot is a page the site
  has (`mount-unknown-slot`) and every permission is a scope the site
  offers (`permission-unknown-scope`).

The lab adds what only it can check, before anything is built:

- Every file the variant's patch changes must be of a kind one of the
  spec's permissions covers (`static.permissions`). A spec that asks for
  `style:write` cannot change markup, whatever the allow list says.
- A file of a kind no scope covers (a shell script, a binary) cannot be
  changed at all.
- The model that writes the patch is shown only the files its spec's
  permissions cover as editable.

The mount is not enforced on the patch. A change to a shared component
shows on every page, and the lab cannot tell from a diff which pages a
file affects. The mount records where the change is meant to show, and
the checks verify it there.

## Alternatives considered

- **Keep the lab's own schema and only borrow the Markdown format.** That
  was the state before. It left Graft unable to say whether a spec is
  valid, and gave variants no per-spec limit beyond the site's config.
- **Allow extra frontmatter keys for some hosts.** It would open the
  schema for every host to fit one. Sections already carry
  host-specific text Graft does not interpret.
- **Slots for regions of a page (header, hero, footer).** Closer to how
  WordPress slots work, but a website has no registry of its regions.
  Guessing them from markup would make the surface unstable between
  builds. Pages are what the lab already verifies.
- **Generate the surface from source files, before the build.** Routes
  live in framework-specific places (files under `app/`, a router config,
  plain HTML), while the built pages are the same for every framework.

## Implementation

In the lab (`swissspidy/lab`), not in this repository:

- `@lab/core` describes a site as a host (`websiteHost`: slots from
  pages, scopes from allowed files) without depending on Graft, and the
  static gate enforces permissions on the patch.
- `@lab/adapters` turns that description into a Graft surface
  (`graftSurface`), writes and reads specs as Graft Markdown, and checks
  each spec against the surface with Graft's `validateSpec`
  (`GraftSpecCheck`). Graft's codes come back prefixed `graft-`.
- The generated surface passes Graft's `validateSurface`.

This repository changes only by this record: Graft's core, schemas and
other hosts are unchanged, so no package release is needed.

## Consequences

- An experiment spec is a valid Graft spec, and Graft's validator is what
  decides whether its mount and permissions fit the site.
- Variants are narrower: each one may change only the kinds of files its
  spec asked for, and a reviewer sees those kinds in the frontmatter.
- The website surface is not checked in and has no version history: it is
  regenerated per experiment, and hashed only when Graft validates it.
  If websites ever need upgrades in Graft's sense, the surface would need
  storing with each experiment.
- Builds for this host are patches, not Graft builds. `graft compile`,
  `graft verify` and `check:builds` do not apply; the lab's builder and
  verifier stand in for them.
