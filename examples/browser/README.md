# A customization of the browser itself

`specs/stale-tabs.md` is for the browser surface (`host: chrome`) of the
[browser extension](../../hosts/chrome-extension/README.md), not for an
app ([ADR 0017](../../docs/adr/0017-browser-activity-undo-and-triggers.md)).
"Stale tabs" lists tabs unused for more than a week in the extension's
side panel, with a **Close** button. Once a day, a trigger closes up to
ten of them on its own, never pinned ones. Every tab it closes can be
opened again from the activity log on the extension's options page.

- `builds/stale-tabs.json`: its A2UI build for the browser surface, with
  nine checks, run in an in-memory browser (`pnpm verify:extension`). It
  was written by hand, checks first.
- `bundles/stale-tabs.json`: the spec and the verified build as one file
  (`pnpm bundle:extension`), which the extension ships and installs
  waiting for approval.
