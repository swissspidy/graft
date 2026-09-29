import type { HostGuide } from '@graft/core';

/** What the compiler needs to know about WordPress beyond the surface. */
export const hostGuide: HostGuide = {
	fixtures: `A JSON object:
{"users": [{"as": "<alias>", "role": "administrator|editor|author|contributor|subscriber"}],
 "posts": [{"title": "<unique title>", "status": "publish|future|draft|pending|private", "author": "<user alias, optional; default the site admin>"}]}
The site has no other posts and no users besides the admin. Posts are created oldest first, in list order. view_as is a user alias from "users". Remember WordPress permissions: authors and above publish their own posts, editors and administrators publish anyone's, contributors publish nothing and only see their own unpublished posts.`,
	assertions: `{"post": {"title": "<title>", "status": "<status>"}}: the post with that title exists and has those fields after the steps.`,
	notes: `WordPress specifics:
- posts.list returns {items: [{id, title, status, type, author: {id, name}, date, modified, edit_url, can: {edit, publish}}], total, pages}. Bind table rows to "<source>.items".
- In a table, give fields an "id" path into the row (e.g. "author.name") and mark the title field "primary": true; its value is the row label checks refer to.
- A table field can compute its value and tone per row instead of reading "id": {"id": "age", "label": "Days since update", "type": "integer", "value": {"$daysSince": {"$field": "modified"}}, "tone": {"$if": [{"$gte": [{"$daysSince": {"$field": "modified"}}, 30]}, "error", "success"]}}. Checks read it with a "cell" expectation; its text is the formatted value.
- Fixture posts are created within the last two hours, and modified when created. To see them older, give the check "advance_days".
- A widget's table takes the same "fields" as a table, with the rows as plain data (its render function filters or sorts them).
- Per-post permission: {"$can": "posts.status:write"} inside a table row, or with "on": {"$slot": "post"} in a row action, uses the post's own can flags.
- The posts.list.row-actions slot renders once per post on the Posts screen with {"post": {id, title, status, type, can}}. WordPress renders that list, so row actions should end with "then": ["reload:page"].
- Every action (button, table action, row-action) needs an "id" matching the action ids the checks use.`,
};
