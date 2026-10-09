# @swissspidy/graft-a2ui

A2UI v0.9 surfaces as a Graft build's UI, on [`@a2ui/web_core`](https://www.npmjs.com/package/@a2ui/web_core)
(Apache-2.0). A build's UI is an A2UI surface (`ui`), with `events` binding
its action events to capability calls. Everything else in the build, and
everything around it (spec, frozen checks, gateway, grants, verification,
upgrades), stays Graft's. See [ADR 0009](https://github.com/swissspidy/graft/blob/main/docs/adr/0009-a2ui.md).

```sh
npm install @swissspidy/graft-a2ui @swissspidy/graft-core
```

This package has no renderer. It gives core the A2UI format
(`createA2UIFormat`, registered by each host with `registerUiFormat`):

- **The Graft catalog** (`catalog.ts`): the basic catalog's layout, text,
  button and input components and a Table, with `visible` on every
  component, `actionId` on buttons, and functions on top of A2UI's own
  (comparisons, arithmetic, strings, lists, `if`, `can`, `daysSince`, and
  the local action `set`). Every component and function argument has a zod
  schema. Hosts give the catalog its id (`graft:wordpress`,
  `graft:emdash`), may drop components they cannot draw and add their own.
- **Validation** (`validate.ts`): structure, references, props and
  function arguments against the schemas, JSON Pointers, inputs, events
  and the capability inputs they make.
- **The walk** (`walk.ts`): the surface resolved for one viewer, with
  web_core's data model and resolution, handed to a drawer. The verifier's
  snapshot is one drawer (`snapshot.ts`); EmDash's Block Kit renderer is
  another.
- **Refs, migrations, slot props and the compiler's UI phase** (`format.ts`).

`@swissspidy/graft-a2ui/client` is what a browser renderer needs without core's
validation: the Graft catalog, the data model's seeding, table fields and
event inputs. WordPress draws A2UI builds with
[a2ui-wp](https://www.npmjs.com/package/@swissspidy/a2ui-wp) (React,
`@wordpress/components`, on web_core) and those.
