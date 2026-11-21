# Graft for web apps, through a browser extension

A prototype host for customizing web apps you do not control: SaaS tools
with no plugin API. A Manifest V3 extension draws verified A2UI builds
into the app's own pages, and a gateway in its service worker makes
every call to the app's API with your session, only as far as you
approved. The same extension also customizes the browser itself: a
second surface whose capabilities are your tabs and whose slot is the
extension's side panel. Everything customizations change is in an
activity log, with Undo where the change can be put back, and
customizations can run on their own on a schedule. The design and its
limits are in [ADR 0011](../../docs/adr/0011-browser-extension-host.md)
[ADR 0017](../../docs/adr/0017-browser-activity-undo-and-triggers.md)
and [ADR 0018](../../docs/adr/0018-preview-and-safe-mode-in-the-extension.md).

The target app here is **Tasklet** (`fixtures/tasklet`), a small task
tracker standing in for a third-party app: pages with ARIA landmarks, a
JSON API behind a session cookie, a CSRF header on writes, roles, a
strict CSP, and three versions that change the way real apps do. Tests
never touch a real site.

## Try it

```sh
pnpm install
pnpm build:extension      # the unpacked extension in hosts/chrome-extension/adapter/dist/extension
pnpm serve:extension      # Tasklet on http://127.0.0.1:4490 (--version 2 or 3 for a changed app)
```

1. In Chrome, open `chrome://extensions`, turn on Developer mode, and
   **Load unpacked** `hosts/chrome-extension/adapter/dist/extension`.
2. Open the extension's options: **My open tasks** waits for approval,
   with what it may do and the checks it passed. **Preview** shows it
   in Tasklet with your data for ten minutes, without its buttons.
   Approve it.
3. Sign in to Tasklet at http://127.0.0.1:4490/login?as=ada (a member;
   `grace` is a guest, `lin` the owner). The project's sidebar now shows
   Ada's open tasks, the overdue one marked, with **Done** buttons.
4. Mark a task **Done**, then find it under **Activity** on the options
   page: **Undo** opens it again in Tasklet.
5. Approve **Stale tabs** too and click the extension's toolbar button:
   the side panel lists tabs you have not used for more than a week.
   Under **Runs on its own**, try a dry run, pause it, or run it now.
   Whatever it closes can be opened again from **Activity**.
6. **Turn on safe mode** at the top of the options page: nothing is
   shown or run until you turn it off, and the options page still works.

Restart Tasklet with `--version 2`: the sidebar's test id is renamed, and
the customization is still there, found by its landmark. With
`--version 3` the API renames a field and the customization says its data
no longer matches, rather than showing anything wrong.

## Layout

| Path | What |
| --- | --- |
| `fixtures/tasklet/server.ts` | The target app, and the fixture protocol (`/__fixture/*`) that makes a copy of it a sandbox |
| `adapter/src/apps/tasklet.ts` | Tasklet described from the outside: slots as DOM anchors, capabilities as API bindings, scopes as app roles, and where the drift probe looks. A description may also list `locked` areas (a payment form, legal text): an anchor found inside one is broken, never re-anchored there ([ADR 0013](../../docs/adr/0013-operating-and-recovering.md)) |
| `adapter/src/host` | The browser host: surface model, URL patterns, HTTP bindings and output projection, anchor resolution, the `graft:browser` catalog and view renderer, the gateway |
| `adapter/src/host/undo.ts`, `activity.ts`, `runner.ts` | Undo declared next to a write's binding, the activity log, and running triggers through the gateway |
| `adapter/src/browser` | The browser's own surface (`host: chrome`): the side panel slot, and tab capabilities over a small tab API |
| `adapter/src/extension` | The MV3 service worker (gateway, store, activity, undo, triggers on `chrome.alarms`), content script, side panel, options page, generated manifest |
| `adapter/src/node` | The sandbox, the drift probe, upgrading after drift, and the CLI |
| `adapter/surfaces/tasklet.json` | The Tasklet surface, fingerprinted against Tasklet 1 |
| `adapter/surfaces/chrome.json` | The browser surface, generated from `src/browser` |
| `e2e` | Playwright with the unpacked extension in Chromium, and the drift tests |

The example customizations are in
[`examples/chrome-extension`](../../examples/chrome-extension) (for
Tasklet) and [`examples/browser`](../../examples/browser) (for the
browser): their specs, builds and the bundles the extension ships.

## Commands

```sh
pnpm surface:extension [--check]           # write (or check) surfaces/tasklet.json and surfaces/chrome.json
pnpm drift:extension [--app-version 2] [--url <app>] [--out observed.json] \
  [--spec examples/chrome-extension/specs [--sandbox <copy url>]] examples/chrome-extension/builds/my-tasks.json
pnpm verify:extension                      # the example builds' checks: against a Tasklet copy, and in an in-memory browser
pnpm bundle:extension                      # verify them and write their bundles
pnpm build:extension [--surface <file>]... [--bundle <file>]...
pnpm test:e2e:extension                    # build, then Playwright in Chromium
```

`drift` probes the app (a fixture Tasklet unless `--url`), prints which
slots and capabilities drifted, writes the observed surface, and with
`--spec` takes each build up the upgrade ladder, verified in a copy of
the changed app. It exits 1 when the app drifted.

The drift probe, the surface command and the end-to-end tests need
Chromium: Playwright's own (`pnpm exec playwright install chromium`), or
another one with `CHROMIUM=/path/to/chrome`.
