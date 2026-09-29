# ADR 0005: An escape hatch: pure functions in a WebAssembly sandbox

- Status: Accepted (WordPress prototype)
- Date: 2026-09-29
- Builds on: [ADR 0001](0001-architecture.md), [ADR 0003](0003-emdash-host.md)

## Context

Builds are declarative: a tree of surface components, data sources and an
expression language that is not Turing-complete. That is what makes them
checkable, upgradable and safe to run in someone's admin. Some requests
still don't fit it.

We took the proposal for a sandboxed escape hatch in two steps:

1. **Grow the expression language first.** Many requests that looked like
   they needed code only needed a few more operators. We added
   comparisons, `$if` and `$daysSince`, and table cells with a computed
   value and tone. "Days since the last update, colored by age" is now
   declarative (the `stale-drafts` example on both hosts). Checks can
   look later with `clock.advanceDays`, and expect a cell's text and tone.
2. **Code only where expressions run out.** Some logic needs a real
   language: regexes, loops, string handling. For example, "flag
   headlines that are too long, in capitals, or too short, and list every
   problem". This ADR is about that step.

The constraint from the proposal stays: code runs client-side only, and
server effects happen only through capabilities the build declares, via
the host gateway.

## Decision

### What code may do: compute values, nothing else

A build may carry `code`: plain JavaScript declaring top-level functions,
plus the list of functions it exposes. Props call a function with
`{"$fn": "name", "args": [...]}`.

- **Arguments.** Arguments are evaluated first (bindings, fields and so
  on) and passed in as JSON. A function sees its arguments and nothing
  else.
- **No reads, no calls.** Code cannot read data, call a capability, or
  touch the page. Actions stay declarative `$call`s, so everything the
  gateway, grants, approvals and checks rely on is unchanged. The
  proposal's "read/invoke/render" capabilities were left out on purpose:
  - read and invoke would make a build's reach depend on running code,
    not on what it declares;
  - render is step 3 (below).
- **Results are inert.** A result is JSON data: strings, numbers,
  booleans, arrays and plain objects. Object keys starting with `$` are
  dropped, so a function cannot produce an expression or an action. The
  core enforces this in the evaluator (`inert()`), whatever the sandbox
  returns.
- **Where `$fn` is allowed.** Validation refuses `$fn` inside a `$call`
  input or a data source input. Code may choose which declared action is
  shown (a `$fn` as an `$if` condition), never what is read or written.
- **Only on hosts that run it.** A surface declares `functions` with its
  runtime and limits. Code and `$fn` are refused on surfaces without it,
  and the plugin never serves such a build there. WordPress declares
  functions; EmDash does not (yet).

### Where it runs: QuickJS compiled to WebAssembly, in a Web Worker

`@graft/sandbox` runs code in QuickJS (`quickjs-emscripten`, the
`release-sync` WebAssembly build).

**The realm.** Each build gets a fresh QuickJS runtime.
- It has only ECMAScript built-ins: no `window`, `document`, `fetch`,
  storage, cookies, timers, workers or promises.
- Arguments and results cross as JSON text, so no host object is ever
  reachable.
- The caller that parses the arguments and serializes the result is set
  up before the build's code runs. The code therefore cannot swap out the
  `JSON` it uses.

**Limits.** They come from the surface; WordPress uses these:

| Limit | WordPress | Enforced by |
| --- | --- | --- |
| Time per call | 50 ms | QuickJS interrupt handler. Loading the code and reading a function's name are timed too, so a looping getter is stopped. |
| Memory for the realm | 8 MB | QuickJS memory limit |
| Result size | 16 KB | JSON length after the call |
| Source size | 32 KB | Validation |

**Where it runs, by context:**
- **In wp-admin**, a Web Worker (`build/functions-worker.js`) hosts
  QuickJS. The page talks to it in batches, and a watchdog terminates the
  worker if a batch overruns anyway. After two restarts, the build's
  functions stay off. Once QuickJS has loaded, the worker removes `fetch`,
  `XMLHttpRequest`, `WebSocket`, `importScripts`, `indexedDB` and
  `caches` from itself. Even a flaw in QuickJS would then find nothing to
  use: the code is two boundaries from the page (the WebAssembly realm,
  then the worker).
- **In the verifier** (Node, and wp-admin's in-browser verification),
  the same QuickJS build runs in-process and synchronously, under the same
  limits. The code that is verified is the code that is served, on the
  same engine.

**How rendering handles it.**
- `$fn` evaluates through `EvalContext.fn`. The React renderer caches
  results by function and arguments, which is valid because the functions
  are pure.
- On a cache miss, the value is `undefined` and the call is queued. After
  the render, queued calls go to the worker in one batch, and the tree
  renders again.
- A failed call shows as null. The verifier records it as a check
  failure ("Function "x" failed: ... ran longer than 50 ms and was
  stopped").

**Lazy loading.** The worker script and QuickJS are fetched only when a
build with code renders its first `$fn`. The plugin only tells a screen
where the worker is when a build on that screen has code. The always
loaded runtime grew by 3 KB.

### The gateway keeps an audit log

The gateway already refused calls a build had not declared or was not
granted. It now records every refusal: time, user, spec, capability and
code. It keeps the latest 100 for administrators (`GET graft/v1/audit`)
and fires `graft_gateway_refused` for site logging. Code cannot call the
gateway at all, so a refusal means a declared action outside its grant,
or someone calling the endpoint by hand.

### Lifecycle

**Compiler.** On surfaces with functions, the compiler's tree output has
a `code` field (null when expressions suffice), and the prompt says to
use it only when expressions cannot compute a value. A failing or looping
function fails verification like any other check, and the failure goes
back to the model (`pnpm test:compile` covers a looping first answer).

**Upgrades.**
- The static check notices a surface that no longer runs functions. That
  change forces regeneration, and the canary reports it as "the host no
  longer runs build functions".
- Changed limits only need a re-verification.
- Code is carried through migration, re-anchoring and regeneration.

## Options compared

Measured on this repository's container: Chromium from Playwright, and
Node 22. The workload is the headline check's code.

| | Size (min / gzip) | Start | Per call | Isolation from the page | CPU limit | Memory limit | Verifier parity |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **QuickJS/Wasm in a Worker** (chosen) | worker 57 KB / 17 KB, wasm 503 KB / 231 KB | 34–36 ms cold (worker, wasm fetch and compile, realm); 1 ms per extra realm | about 55 µs in Node; batch of 20 in 6–11 ms, round trip about 1 ms | Separate realm, JSON-only boundary, inside a worker | Interrupt handler, plus worker termination | Yes | Same engine and limits in Node |
| SES (Hardened JS, `Compartment`) | 238 KB / 48 KB | about 60 ms to load and parse, plus 11–15 ms for `lockdown()` | about 10 µs | Compartment without endowments sees no `document`. But `lockdown()` freezes the *page's* built-ins (`Array.prototype` is frozen afterwards), which wp-admin's scripts and other plugins do not expect | None on the main thread: an infinite loop hangs the admin. In a worker, termination only | No | Node supports it; different engine semantics from a Wasm realm |
| Plain Web Worker | 0 KB | 6–8 ms for start and a batch of 20 | native | The worker still reaches `fetch`, `indexedDB` and `importScripts` (measured). Deleting globals by hand is a deny-list that has to be complete | Termination only | No | Worker semantics differ from Node |
| Extism (Wasm plugin host) | runtime 138 KB / 50 KB, plus a plugin per build | Not measured: JavaScript plugins need the Extism JS PDK toolchain to compile each build's code to Wasm, which QuickJS inside does anyway | n/a | Strong (Wasm, host functions opt-in) | Timeouts | Yes | Needs a build step per build, and a compiler toolchain on the host |
| `@arrow-js/sandbox` | Not measured. Built on `quickjs-emscripten` (all variants), with `acorn` and the TypeScript compiler as dependencies | n/a | n/a | QuickJS realm (async build) with a DOM bridge for Arrow templates | QuickJS | QuickJS | Aimed at rendering, not pure functions |

**Why QuickJS/Wasm:**
- It is the only option with real CPU and memory limits in every place
  code runs.
- Its isolation doesn't depend on a deny-list.
- It doesn't change the host page.
- The verifier runs the exact engine the admin runs.

**What it costs:** 231 KB gzipped of wasm, and about 35 ms, on the
screens that use code only. SES is smaller and faster per call, but
`lockdown()` in wp-admin is a non-starter, and it has no CPU limit
outside a worker. Extism would be a good fit for code compiled ahead of
time; a model writing JavaScript per build isn't that.

## Acceptance criteria and where they are tested

| Criterion | Test |
| --- | --- |
| No window, document, fetch, storage or cookies | `packages/sandbox/test/sandbox.test.ts` (globals probe, code built at runtime, hostile getters and thrown proxies) |
| An infinite loop is stopped within its budget | The same file, at call and at load time. `pnpm test:compile`: a looping build fails verification and is fixed |
| Writes only via declared abilities; undeclared ones rejected and logged | `packages/core/test/functions.test.ts` (no `$fn` in inputs, inert results); `hosts/wordpress/e2e`: the gateway's audit log after a contributor's undeclared calls |
| The example passes in the canary and survives a recompile | `pnpm test:canary`: tenant `newsdesk` runs the headline check through every scenario. It is regenerated with its code under `change-list-input`, and fails under `no-functions` |
| The runtime is not loaded on screens without code | `hosts/wordpress/e2e`: the review queue loads neither the worker nor QuickJS; the dashboard with the headline check loads both |

## Consequences

- **The example.** `examples/specs/headline-check.md` is verified in
  Playground and served in wp-admin.
- **Determinism.** Inside the sandbox, `Date` and `Date.now()` report the
  time the host passes with each call. The page passes its current time;
  the verifier passes the check's clock, so `clock.advanceDays` applies to
  code as it does to `$daysSince`. `Math.random()` is a PRNG reseeded on
  every call, so a function gives the same result for the same arguments
  at the same time. The replacement `Date` is also what
  `Date.prototype.constructor` returns, so reaching for the original
  through the prototype finds the frozen one.
- **EmDash.** EmDash renders on the server, in the plugin or in EmDash's
  own workerd sandbox. Running QuickJS there is possible (it is plain
  Wasm), but loading a wasm file in the sandboxed plugin format needs
  work. Until then, EmDash surfaces do not declare functions.
- **Step 3: interactive widgets.** Components drawn by code, with events,
  are the next step and need a render bridge. `@arrow-js/sandbox` shows
  one shape for it: templates rendered by trusted host code from a
  QuickJS realm. That would be a new component kind in the surface, with
  its own checks, and is not part of this decision. It became
  [ADR 0006](0006-interactive-widgets.md), which keeps the host's own
  components drawing instead.
