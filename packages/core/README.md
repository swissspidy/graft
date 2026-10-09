# @swissspidy/graft-core

The host-agnostic core of [Graft](https://github.com/swissspidy/graft):
durable, spec-driven customizations for multi-tenant apps. A customization's
source of truth is a short **spec** (what it should do, how we know it does
it, what it may touch). Graft compiles it into a declarative **build** for
one version of a host, verifies the build against the spec's acceptance
criteria, and migrates, re-anchors or regenerates it when the host changes.

```sh
npm install @swissspidy/graft-core
```

No I/O: hosts and tools bring their own storage, sandboxes and models.

- **Specs** (`parseSpec`, `validateSpec`, `hashSpec`): Markdown with YAML
  frontmatter, against the [spec schema](https://github.com/swissspidy/graft/blob/main/schemas/spec.schema.json)
  and a host's surface.
- **Surfaces** (`validateSurface`, `hashSurface`): what a host version
  offers builds: slots, capabilities, scopes.
- **Builds** (`validateBuild`, `extractRefs`, `evaluate`): an A2UI surface
  with data sources, frozen checks and refs. Core reads the UI through a
  registered UI format (`registerUiFormat`); [`@swissspidy/graft-a2ui`](https://www.npmjs.com/package/@swissspidy/graft-a2ui)
  is the A2UI one.
- **Verification** (`verifyBuild`): runs a build's checks against a host
  sandbox you provide.
- **Compiling** (`compileSpec`): checks, then the UI, from a model you
  provide, with retries fed by validation and verification.
- **Upgrades** (`staticCheck`, `upgradeBuild`, `runCanary`): the upgrade
  ladder (re-verify, migrate, re-anchor, regenerate) across host versions.

Entry points:

| Import | What |
| --- | --- |
| `@swissspidy/graft-core` | Everything above |
| `@swissspidy/graft-core/runtime` | What a browser renderer needs: expression evaluation, no schemas or Ajv |
| `@swissspidy/graft-core/parse` | Spec parsing only |
| `@swissspidy/graft-core/cfworker` | A JSON Schema engine for runtimes without code generation (`setSchemaEngine(cfworkerEngine())`) |

Pre-1.0: the API follows the repository and may change between minor
versions. See the [architecture decision records](https://github.com/swissspidy/graft/tree/main/docs/adr)
for the design. Apache-2.0.
