# Changesets

This repository uses [changesets](https://github.com/changesets/changesets) to version and publish the npm packages, `@swissspidy/graft-core` and `@swissspidy/graft-a2ui`. The other workspace packages are private and never versioned.

- Run `pnpm changeset` in a pull request that changes a published package and pick a bump. The two packages are versioned together, so one changeset covers both.
- When changesets land on `main`, the release workflow opens a "Version packages" pull request that bumps the versions and updates the `CHANGELOG.md` files.
- Merging that pull request stages the new versions on npm, with provenance. A maintainer then approves each staged version with 2FA, under Staged Packages on npmjs.com or with `npm stage approve <stage-id>`; the job summary lists the stage IDs.

## What the release workflow needs

- Each package on npm lists this repository, `release.yml` and the `npm` environment as its trusted publisher, allowing staged publishes. npm accepts the publishing job's OIDC token instead of a stored token, and adds provenance.
- "Allow GitHub Actions to create and approve pull requests" enabled under Settings → Actions → General, so the action can open the "Version packages" pull request.

## How the release workflow runs

It has three jobs, so that the only job that can publish installs and runs nothing from the dependency tree:

1. `version` runs on every push to `main`. Changesets opens or updates the "Version packages" pull request; it installs with `--ignore-scripts` and has no OIDC token. When `main`'s packages carry versions npm does not have yet (that pull request was merged), the push is a release.
2. `pack` installs, runs the typecheck, the tests and `pnpm test:packages`, and packs each package with `pnpm pack`, which builds it and rewrites `workspace:` ranges to the released versions. It has no OIDC token either.
3. `publish` is the only job with `id-token: write`. It installs nothing: it stages the tarballs with `npm stage publish` (npm 11.15.0 or later, which the job checks; prereleases under the `next` dist-tag), then tags each `name@version` and creates its GitHub release from the package's `CHANGELOG.md`. Versions already on npm and existing tags are skipped, so a run that failed partway can be re-run. A staged version is not on npm until it is approved, though, so approve or reject what a failed run staged before re-running it.
