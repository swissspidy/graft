# Graft for EmDash

The [EmDash](https://github.com/emdash-cms/emdash) host adapter. For the
design, see [ADR 0003](../../docs/adr/0003-emdash-host.md) and, for the
sandboxed plugin and writing customizations in the admin,
[ADR 0004](../../docs/adr/0004-emdash-sandbox-and-authoring.md).

| Path | What |
| --- | --- |
| `adapter/src/host` | Pure, used by the plugin and by Node: surface, components, tree to Block Kit translation, verifier semantics, `$can`, check describers, compiler guide |
| `adapter/src/plugin` | The plugin: routes shared by both formats, capabilities over EmDash content, gateway and serving, KV store, authoring (compile jobs, Claude API client), sandbox route. `index.ts` is the native entry, `standard.ts` the sandboxed one |
| `adapter/src/index.ts` | The plugin descriptors for `astro.config`: `graft()` (native) and `graftSandboxed()` |
| `adapter/emdash-plugin.jsonc` | The manifest for EmDash's plugin CLI and registry, generated from `src/plugin/manifest.ts` |
| `adapter/scripts` | Bundling the sandboxed plugin, writing the manifest |
| `adapter/src/node` | Node tooling: start EmDash, the sandbox driver, verification, surface generator, smoke test |
| `adapter/surfaces` | Surface snapshots |
| `site` | A minimal EmDash site (Node, SQLite) with the plugin, for development and tests |
| `e2e` | Playwright tests in the EmDash admin, and the seeded server they use |

## Install the plugin in an EmDash site

In-process (native format):

```js
// astro.config.mjs
import { graft } from '@graft/emdash';

emdash({ plugins: [graft()] });
```

Or in EmDash's plugin sandbox (standard format; build the bundle first with
`pnpm build:emdash`):

```js
import { graftSandboxed } from '@graft/emdash';

emdash({ sandboxed: [graftSandboxed()], sandboxRunner: '@emdash-cms/sandbox-workerd' });
```

Customizations appear under **Plugins → Customizations** as tabs, in a
**Customizations** widget on the dashboard, and in a **Customizations**
panel in the entry editor.

Builds with code ([ADR 0005](../../docs/adr/0005-sandboxed-functions.md))
run it on the server, in QuickJS: compiled to WebAssembly in the native
plugin, to asm.js in the plugin sandbox, which compiles no WebAssembly.
Interactive widgets ([ADR 0006](../../docs/adr/0006-interactive-widgets.md))
are drawn there too, as Block Kit; their state travels in the buttons.

### Writing customizations in the admin

Administrators write specs in the **Manage** tab. Set an Anthropic API key
(and optionally the model and effort) in the plugin's settings first; the
site needs `EMDASH_ENCRYPTION_KEY` to store it. **Build it** writes the
checks, and **Continue building** takes each next step (one model call per
step, so each fits in one request). The finished build is stored as a
draft: verify it with `graft site verify`, then approve it in the Manage
tab.

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
pnpm test:emdash:sandboxed      # the same, with the plugin in EmDash's sandbox (workerd)
pnpm test:author:emdash         # writing a customization in the admin, with a stubbed Claude API
pnpm build:emdash               # bundle the sandboxed plugin into adapter/dist
pnpm manifest:emdash [--check]  # regenerate or check emdash-plugin.jsonc
pnpm test:compile:emdash        # compile pipeline with a scripted model
pnpm test:canary:emdash         # synthetic EmDash changes against fixtures/canary/emdash
pnpm test:site:emdash           # graft site against a live EmDash
pnpm graft canary --corpus fixtures/canary/emdash --from hosts/emdash/adapter/surfaces/1.0.json --scenario move-editor-panel
pnpm test:e2e:emdash            # Playwright in the EmDash admin
pnpm graft verify --surface hosts/emdash/adapter/surfaces/1.0.json --spec examples/emdash/specs examples/emdash/builds/*.json
pnpm graft compile examples/emdash/specs/publish-queue.md --surface hosts/emdash/adapter/surfaces/1.0.json --out publish-queue.build.json
```
