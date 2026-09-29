# ADR 0004: EmDash's plugin sandbox, and writing customizations in its admin

- Status: Accepted
- Date: 2026-09-29
- Builds on: [ADR 0003](0003-emdash-host.md)

## Context

ADR 0003 left two gaps on EmDash:

1. **The plugin only ran in-process** (EmDash's native format). Installing
   from EmDash's registry, and running on Cloudflare, needs the standard
   format. That format runs plugins in a sandbox: workerd on Node, Worker
   Loader on Cloudflare. The sandbox has three constraints:
   - no code generation at runtime;
   - a single bundled module;
   - limits per invocation: 30 seconds of wall time everywhere, and 50 ms
     of CPU on Cloudflare.
2. **Customizations could only be written outside the site.** On
   WordPress, admins write them in wp-admin (ADR 0002).

## Decisions

### One set of routes, two formats

The plugin's routes live once, in `src/plugin/routes.ts`. They take the
request and the plugin context apart, and each format wraps them in a few
lines:

- **Native** (`src/plugin/index.ts`) is configured with `graft()` in
  `plugins: []`. It keeps the verification sandbox route.
- **Standard** (`src/plugin/standard.ts`) is configured with
  `graftSandboxed()` in `sandboxed: []`, or installed from the registry:
  - `pnpm build:emdash` bundles it into `dist/sandbox-entry.mjs` with
    esbuild. The SDK's browser build keeps Node built-ins out.
  - `emdash-plugin.jsonc` is generated from `src/plugin/manifest.ts` and
    validated in CI with EmDash's own plugin CLI.

Both formats get their capabilities, admin pages and settings from
`manifest.ts`, so they cannot drift apart. The sandbox reports route
errors as a 500 with the message rather than a 400. The EmDash validator
does not allow a root admin page path, so the page is `/customizations` in
both formats.

The permission checks no longer import `@emdash-cms/auth`. A small table of
the permissions Graft uses (`src/host/permissions.ts`) is compared with
EmDash's in a test.

### A JSON Schema engine without code generation

Ajv compiles validators into functions at runtime, which the sandbox
refuses. The core also compiled its contract schemas when it was imported.
The core now validates through a schema engine
(`packages/core/src/schema.ts`):

- **Lazy compilation.** Nothing compiles at import time; validators are
  compiled on first use and cached per schema.
- **Ajv stays the default engine.**
- **A second engine for sandboxes.** `@graft/core/cfworker`, built on
  `@cfworker/json-schema`, generates no code. It maps errors to Ajv's
  shape, so diagnostics read the same.
- **A workerd workaround.** Under workerd, cfworker resolves `$ref`
  against an absolute `$id` incorrectly. Graft's schemas only use local
  references, so the engine drops the root `$id`.

**Differences from Ajv.** cfworker does not reject unknown keywords in a
schema. Surfaces are still generated and checked with Ajv.

**How parity is kept.**
- A test runs the examples of both hosts, and broken builds, through both
  engines and compares the diagnostics.
- CI runs the whole test suite a second time on cfworker
  (`pnpm test:cfworker`).

### Writing customizations in the EmDash admin

The Manage tab starts with a spec editor, a Block Kit form, available to
administrators only. **Build it** validates the spec against the site's
surface and sends back problems with the text kept. A valid spec starts a
compile.

- **The model.** The plugin calls the Claude API with the official
  Anthropic SDK:
  - Its `fetch` is the plugin's `ctx.http.fetch`, so requests are limited
    to the plugin's allowed hosts (`api.anthropic.com` by default) and go
    through EmDash's SSRF checks.
  - The API key, model, effort and endpoint are plugin settings. EmDash
    generates the settings form, and the key is a `secret` setting,
    stored encrypted.
  - Responses are not streamed, because EmDash buffers plugin HTTP
    responses.
  - Refusals fall back server-side.
- **One model call per step.** A compile makes several calls, longer in
  total than one sandboxed invocation may run. So a compile is a job in
  KV, and each step replays the recorded answers through the unchanged
  core compiler, makes the next call, records it and stops. Replaying is
  deterministic because prompts depend only on the spec, the surface and
  earlier answers. The first step runs when the admin clicks **Build it**,
  and each later one when they click **Continue building**. A failed call
  is not recorded, so continuing retries it.
- **Built means a draft.** The site cannot run checks on itself without
  touching its own content, and EmDash has no equivalent of Playground to
  start in the admin's browser. So a finished build is stored as an
  unverified draft. `graft site verify` then verifies it in a throwaway
  EmDash; the version waits for approval, and the admin approves it in
  the Manage tab. This is the path ADR 0002 already takes on WordPress
  when Playground can't start.

## Tests

- `pnpm test:emdash:sandboxed` runs the plugin smoke test with Graft in
  EmDash's plugin sandbox on workerd. The smoke test now seeds and checks
  content through EmDash's REST API, so it runs against either format.
- `pnpm test:author:emdash` writes a customization in the admin in both
  formats, against a stand-in for the Claude API:
  - The test site's dev-only middleware (`site/src/test-model.ts`) routes
    the plugin's Claude API requests to the stub, and answers the DNS
    lookup that EmDash's SSRF check makes.
  - The stub's first tree is invalid, so the test also covers rejection
    and retry.
  - It then covers `graft site verify`, approval, and serving.
- The browser tests write a customization in the real admin UI.

## Consequences

- **Registry and Cloudflare.** Graft can be installed from EmDash's
  registry and run on Cloudflare. That is untested on Cloudflare itself;
  CI runs the Node sandbox (workerd). Publishing needs the publisher's
  atproto DID in `emdash-plugin.jsonc`.
- **Unmeasured CPU limit.** On Cloudflare, sandboxed invocations get 50
  ms of CPU. Validating a large build on cfworker may exceed that. It has
  not been measured.
- **Manual steps.** Admins click **Continue building** once per model
  call, a handful of times. A background runner (EmDash's cron ticks on a
  timer) could take over when the host allows long invocations.
- **Bundle size.** The sandboxed bundle is about 900 KB, most of it the
  SDK.
- **Verification still leaves the site.** A verification service, or
  signed verification (ADR 0002's future work), would let a site verify
  without an operator's terminal.
