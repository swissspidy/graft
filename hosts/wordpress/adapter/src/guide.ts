import type { HostGuide } from '@graft/core';

/** What the compiler needs to know about WordPress beyond the surface. */
export const hostGuide: HostGuide = {
	fixtures: `A JSON object:
{"users": [{"as": "<alias>", "role": "administrator|editor|author|contributor|subscriber", "name": "<display name, optional; default the alias with its first letter capitalized>"}],
 "posts": [{"title": "<unique title>", "status": "publish|future|draft|pending|private", "author": "<user alias, optional; default the site admin>", "excerpt": "<optional>",
   "type": "<optional post type from the surface's model; default post>", "meta": {"<exposed field>": <value>}, "terms": {"<taxonomy>": ["<term slug>"]}}],
 "terms": {"<taxonomy>": [{"name": "<name>", "slug": "<slug>"}]}}
"terms" creates terms up front (a post's term slugs are created when missing, named after the slug). The site's post types, fields and taxonomies are those in the surface's "model"; nothing else exists.
The site has no other posts and no users besides the admin. Posts are created oldest first, in list order. view_as is a user alias from "users". Pages show users by display name (e.g. a post's author.name), never by alias. Remember WordPress permissions: authors and above publish their own posts, editors and administrators publish anyone's, contributors publish nothing and only see their own unpublished posts.`,
	assertions: `{"post": {"title": "<title>", "status": "<status>", "excerpt": "<excerpt>", "meta": {"<field>": <value or null for none>}, "terms": {"<taxonomy>": ["<slug>"]}}}: the post with that title exists and has those fields (any of status, excerpt, meta, terms; terms compares the whole set of slugs in each taxonomy given) after the steps.`,
	notes: `WordPress specifics:
- posts.list returns {items: [{id, title, status, type, author: {id, name}, date, modified, edit_url, meta, terms, can: {edit, publish}}], total, pages}. Bind table rows to "<source>.items". It lists one post type ("post_type", default post), optionally with one term ({"term": {"taxonomy": ..., "slug": ...}}), and can order by a custom field ("orderby": "meta.<field>").
- The surface's "model" lists the post types the site exposes, with their custom fields (meta key → schema) and taxonomies. A post's "meta" has its exposed fields (null when unset; read them with "meta.<field>" paths) and "terms" has, per taxonomy, a list of {id, name, slug}.
- posts.update_meta changes custom fields: {"id": ..., "meta": {"<field>": <value, or null to remove>}} (scope posts.meta:write). posts.set_terms changes a post's terms in one taxonomy by slug, with "mode": "replace" (default), "add" or "remove" (scope posts.terms:write). terms.list lists a taxonomy's terms. {"$can": "posts.meta:write"} and {"$can": "posts.terms:write"} use the post's own can.edit.
- To test whether a post has a term, use a pure function over "terms.<taxonomy>": the expression language has no "contains".
- In a table, give fields an "id" path into the row (e.g. "author.name") and mark the title field "primary": true; its value is the row label checks refer to.
- A table field can compute its value and tone per row instead of reading "id": {"id": "age", "label": "Days since update", "type": "integer", "value": {"$daysSince": {"$field": "modified"}}, "tone": {"$if": [{"$gte": [{"$daysSince": {"$field": "modified"}}, 30]}, "error", "success"]}}. Checks read it with a "cell" expectation; its text is the formatted value.
- Fixture posts are created within the last two hours, and modified when created. To see them older, give the check "advance_days".
- A widget's table takes the same "fields" as a table, with the rows as plain data (its render function filters or sorts them).
- Per-post permission: {"$can": "posts.status:write"} inside a table row, or with "on": {"$slot": "post"} in a row action, uses the post's own can flags.
- The posts.list.row-actions slot renders once per post on the list screen of one post type (mount option "post_type", default post) with {"post": {id, title, status, type, meta, terms, can}}. WordPress renders that list, so row actions should end with "then": ["reload:page"].
- Every action (button, table action, row-action) needs an "id" matching the action ids the checks use.
- The post.editor.panel slot renders in the block editor's sidebar for each saved post of one type (mount option "post_type", default post) the viewer can edit, with {"post": {id, title, excerpt, status, type, meta, terms, can}} (title and excerpt as saved). Actions that change the post should end with "then": ["reload:page"], which reloads the editor. Checks match its actions and inputs with "row": {"title": ...}.
- Inside a widget, text-input, textarea, checkbox and select take an "id" and a "label"; "value" is what they start with. They show what the viewer enters; "onChange": {"$event": "<name>"} sends the entered value to update as the payload, so the code can react as the viewer types. Declared actions send entered values with {"$input": "<input id>"}, e.g. "input": {"id": {"$field": "id"}, "title": {"$input": "title"}}.
- posts.update_fields changes a post's title and/or excerpt (scope posts:write; {"$can": "posts:write"} uses the post's own can.edit).`,
};
