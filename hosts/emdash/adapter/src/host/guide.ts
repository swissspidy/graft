import type { HostGuide } from '@graft/core';
import { a2uiNotes } from './a2ui.ts';

/** What the compiler needs to know about EmDash beyond the surface. */
export const hostGuide: HostGuide = {
	// New builds are A2UI surfaces; a previous build keeps its format.
	ui: 'A2UI',
	formats: { A2UI: a2uiNotes },
	fixtures: `A JSON object:
{"users": [{"as": "<alias>", "role": "admin|editor|author|contributor|subscriber"}],
 "entries": [{"title": "<unique title>", "status": "draft|published|scheduled", "collection": "posts"}]}
The site has no other entries, and no collection but "posts". Entries are created oldest first, in list order, and have no author, so authors cannot publish them. view_as is a user alias from "users". EmDash permissions: contributors and above read drafts; authors publish their own entries; editors and admins publish any entry; subscribers read no drafts.`,
	assertions: `{"entry": {"title": "<title>", "status": "draft|published|scheduled"}}: the entry with that title exists and has that status after the steps.`,
	notes: `EmDash specifics:
- Builds render as EmDash Block Kit: the tree root is "stack"; buttons go inside "actions" (or a table's "actions").
- content.list returns {items: [{id, collection, title, slug, status, author: {id, name} | null, createdAt, updatedAt, publishedAt, can: {publish}}], hasMore}. Bind table rows to "<source>.items".
- In a table, columns have a "key" path into the row (e.g. "author.name") and one column is "primary": true; its value is the row label checks refer to.
- A column can compute its value and tone per row instead of reading "key": {"key": "age", "label": "Days since update", "format": "number", "value": {"$daysSince": {"$field": "updatedAt"}}, "tone": {"$if": [{"$gte": [{"$daysSince": {"$field": "updatedAt"}}, 30]}, "error", "success"]}}. The admin shows a tone as a colored marker. Checks read it with a "cell" expectation.
- Fixture entries are created and updated when the check starts. To see them older, give the check "advance_days".
- Per-entry permission: {"$can": "content.status:write"} inside a table row, or with "on": {"$slot": "entry"} in the editor panel, uses the entry's own can flags.
- The content.editor.panel slot renders once per saved entry with {"entry": {...same fields as content.list items}}; checks match its actions with "row": {"title": ...}.
- The server re-renders from fresh data after every action: use "then": ["refresh:<source>"] (or "reload:page" in the editor panel), not "remove-row".
- Every action (button, table action) needs an "id" matching the action ids the checks use.
- Functions and widgets run on the server. A widget's render function returns EmDash components, as in the build's tree: tables take "columns" (not "fields") and rows as plain data; buttons go inside "actions" and take "style" (primary, secondary, danger). A widget is a child of the root "stack".`,
};
