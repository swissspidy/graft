# A customization for a web app, through a browser extension

`specs/my-tasks.md` adds "My open tasks" to the sidebar of a project in
Tasklet, the fixture app of the [browser extension host](../../hosts/chrome-extension/README.md):
the viewer's open tasks in that project, overdue ones marked, with a
**Done** button for members.

- `builds/my-tasks.json`: its A2UI build for the Tasklet surface, with
  seven checks (`pnpm verify:extension`).
- `bundles/my-tasks.json`: the spec and the verified build as one file
  (`pnpm bundle:extension`), which the extension ships and installs
  waiting for approval.
