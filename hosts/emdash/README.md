# Graft for EmDash

The [EmDash](https://github.com/emdash-cms/emdash) host adapter. For the
design, see [ADR 0003](../../docs/adr/0003-emdash-host.md).

| Path | What |
| --- | --- |
| `adapter/src/host` | Pure, used by the plugin and by Node: surface, components, tree to Block Kit translation, verifier semantics, `$can`, check describers, compiler guide |
| `adapter/src/plugin` | The native EmDash plugin: capabilities over EmDash content, gateway and serving, KV store, sandbox route |
| `adapter/src/index.ts` | The plugin descriptor for `astro.config` |
| `adapter/src/node` | Node tooling: start EmDash, the sandbox driver, verification, surface generator, smoke test |
| `adapter/surfaces` | Surface snapshots |
| `site` | A minimal EmDash site (Node, SQLite) with the plugin, for development and tests |
| `e2e` | Playwright tests in the EmDash admin, and the seeded server they use |

## Install the plugin in an EmDash site

```js
// astro.config.mjs
import { graft } from '@graft/emdash';

emdash({ plugins: [graft()] });
```

Customizations appear under **Plugins → Customizations** as tabs, in a
**Customizations** widget on the dashboard, and in a **Customizations**
panel in the entry editor.

Install and verify them from a terminal with an API token that has the
admin scope:

```sh
pnpm graft site install <spec.md> <build.json> --site https://example.com --token <token>
pnpm graft site verify --site https://example.com --token <token>   # drafts installed with --no-verify
pnpm graft site pull --site https://example.com --token <token> --out corpus/<tenant>
```

`install` checks the build against the site's surface and verifies it in a
local EmDash sandbox before sending it. Administrators then approve its
permissions in the Manage tab.

## Try it

```sh
pnpm install
pnpm exec tsx hosts/emdash/e2e/server.ts   # seeded EmDash on :4480
```

Then open
http://127.0.0.1:4480/graft-test/login?user=editor&role=40&redirect=/_emdash/admin
to sign in. Other roles: `role=20` contributor, `30` author, `50` admin.

## Commands

```sh
pnpm surface:emdash [--check]   # regenerate or check surfaces/1.0.json
pnpm verify:emdash              # verify examples/emdash builds in an EmDash sandbox
pnpm test:emdash                # plugin smoke test
pnpm test:compile:emdash        # compile pipeline with a scripted model
pnpm test:canary:emdash         # synthetic EmDash changes against fixtures/canary/emdash
pnpm test:site:emdash           # graft site against a live EmDash
pnpm graft canary --corpus fixtures/canary/emdash --from hosts/emdash/adapter/surfaces/1.0.json --scenario move-editor-panel
pnpm test:e2e:emdash            # Playwright in the EmDash admin
pnpm graft verify --surface hosts/emdash/adapter/surfaces/1.0.json --spec examples/emdash/specs examples/emdash/builds/*.json
pnpm graft compile examples/emdash/specs/publish-queue.md --surface hosts/emdash/adapter/surfaces/1.0.json --out publish-queue.build.json
```
