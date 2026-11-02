# Working on Graft

Instructions for coding agents (and people) changing this repository.
[README.md](README.md) says what Graft is; the
[ADRs](docs/adr) say why it is built the way it is.

Graft treats a spec as the source of truth and everything derived from it as
output. The repository works the same way: much of what is checked in is
generated from something else. Change the source, regenerate, check, and
stop only when every check passes.

## Where things come from

| What you want to change | Edit | Regenerate with | Checked by |
| --- | --- | --- | --- |
| Core, renderer, sandbox, CLI behavior | `packages/*/src` | nothing | `pnpm typecheck`, `pnpm test` |
| A published package (`packages/core`, `packages/a2ui`) | its `src`, plus a changeset | `pnpm changeset` | `pnpm test:packages` |
| What WordPress offers builds | `hosts/wordpress/plugin`, `hosts/wordpress/adapter` | `pnpm surface:generate` | `pnpm surface:generate --check` |
| The agency example site | `hosts/wordpress/playground/sites/riverside.php` | `pnpm surface:agency`, then `pnpm bundle:agency` | `pnpm surface:agency --check`, `pnpm verify:agency` |
| What EmDash offers builds | `hosts/emdash/adapter/src` | `pnpm surface:emdash`, `pnpm manifest:emdash` | the same with `--check` |
| What the browser extension offers builds | `hosts/chrome-extension` | `pnpm surface:extension`, `pnpm bundle:extension` | `pnpm surface:extension --check`, `pnpm verify:extension` |
| An example customization | its spec, `examples/**/specs/*.md` | `pnpm graft compile` (needs `ANTHROPIC_API_KEY`) | `pnpm validate:examples`, `pnpm verify:examples` (or `verify:emdash`, `verify:agency`, `verify:extension`) |
| A build's `refs`, spec hash or surface hash | nothing: they are computed | `pnpm graft build <build> --surface <surface> --spec <spec> --fix-refs` | `pnpm graft build` |
| A canary tenant | `fixtures/canary/**` (spec and build together) | as for an example | `pnpm test:canary`, `pnpm test:canary:emdash` |
| A design decision | a new `docs/adr/NNNN-*.md`, linked from the README's ADR table | nothing | review |

Never edit these by hand: `hosts/**/surfaces/*.json`, `examples/agency/surface.json`,
`hosts/emdash/adapter/emdash-plugin.jsonc`, bundles (`examples/agency/managed`,
`examples/chrome-extension/bundles`), and the `refs`, `spec` and `surface`
fields of a build. `hosts/wordpress/plugin/build/` is the output of
`pnpm build` and is not checked in.

## The loop

1. Read the code you are changing and the ADR that covers it.
2. Find the source in the table above. Change only sources.
3. Regenerate everything that derives from what you changed.
4. Run the fast checks:
   ```sh
   pnpm typecheck && pnpm test && pnpm test:cfworker && pnpm validate:examples
   ```
5. Run the slow suites for every host you touched, from the README's
   Tests table (for example `pnpm test:wp` and `pnpm verify:examples` for
   WordPress). They start Playground, EmDash or Chromium and need network
   access the first time. If you can't run one, say which one and why.
6. If anything fails, fix the source the failure names, then go back to step 3.
7. When everything passes, add a changeset if a published package changed,
   update the README and the ADRs if behavior or commands changed, and stop.

A failure that looks wrong in the tools is still a failure. Find the
cause; don't work around it.

## Never

1. Edit a generated file listed above. Regenerate it.
2. Change a build's checks to make it pass. Checks are written from the
   criteria before the build exists and frozen per spec version. When a
   check fails, the build, the host or the spec is wrong.
3. Re-stamp a build onto an edited spec with `--fix-refs` when the edit
   changes its criteria, mount, audience or permissions. Compile it again.
   If you can't (no API key), stop and say so.
4. Skip, disable, loosen or delete a test or check to get green.
5. Let a build reach data or actions other than through the capability
   gateway, or widen a scope, a slot or an audience to make something work.
6. Add a capability, slot or scope to a surface by hand. It comes from the
   host's code.
7. Write a criterion that can't be checked objectively ("looks clean").
   The compiler sends those back to the author, and so should you.
8. Ship a change to `packages/core` or `packages/a2ui` without a
   changeset. The other workspace packages are private and need none.

## Conventions

- Node 24+ and pnpm. TypeScript runs as is with `tsx`; the `build*`
  scripts only bundle clients and packages (`pnpm build` for the
  WordPress plugin's client, `build:emdash`, `build:extension`,
  `build:packages`).
- Tabs for indentation; ESM with `.ts` extensions in imports.
- Diagnostics have a stable `code` (`build-refs-mismatch`) and a message
  that says what to do. Tests prefer asserting on codes.
- Docs and messages are plain prose: short sentences, no marketing.
