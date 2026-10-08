import { createA2UIFormat, type A2UIFormatHost } from '@graft/a2ui';
import { registerUiFormat } from '@graft/core';
import { cell, type Field } from './cells.ts';

/**
 * A2UI on WordPress: the Graft catalog as `graft:wordpress`, with tables
 * whose cells read as the WordPress table draws them. Registering the
 * format lets validation, verification, upgrades and the compiler take
 * A2UI builds next to trees.
 */
export const wordpressA2UI: A2UIFormatHost = {
	host: 'wordpress',
	catalogId: 'graft:wordpress',
	cell: (field, record, evaluate) => cell(field as Field, record, (value) => evaluate(value), 'en-US') as { text: string; tone?: string },
};

export const wordpressA2UIFormat = createA2UIFormat(wordpressA2UI);

registerUiFormat(wordpressA2UIFormat);

/** What the compiler should know about WordPress when building A2UI surfaces. */
export const a2uiNotes = `WordPress specifics:
- posts.list returns {items: [{id, title, status, type, author: {id, name}, date, modified, edit_url, meta, terms, can: {edit, publish}}], total, pages}. Bind table rows to /<source>/items. It lists one post type ("post_type", default post), optionally with one term ({"term": {"taxonomy": ..., "slug": ...}}), and can order by a custom field ("orderby": "meta.<field>").
- Table field types: "string", "user" (a person's name), "date", "datetime", "status" (a post status, shown as its label), "integer", "boolean".
- Per-post permission: {"call": "can", "args": {"scope": "posts.status:write"}} in a table row uses that row's post; for the slot's post pass "on": {"path": "/slot/post"}.
- The post.editor.panel slot renders in the block editor's sidebar for each saved post the viewer can edit, with /slot/post = {id, title, excerpt, status, type, meta, terms, can} (title and excerpt as saved). Events that change the post should end with "then": ["reload:page"], which reloads the editor (and with it the saved values and the form). Checks match its actions and inputs with "row": {"title": ...}, which refers to that post.
- The posts.list.row-actions slot renders once per post on the posts list screen, with /slot/post = {id, title, status, type, meta, terms, can}; its root is the one Button for that post. WordPress draws that list, so its events end with "then": ["reload:page"].
- The dashboard.widget slot is a Dashboard box with no slot data: draw from data sources.
- posts.update_fields changes a post's title and/or excerpt (scope posts:write). posts.update_status changes its status (scope posts.status:write). posts.update_meta changes custom fields: {"id": ..., "meta": {"<field>": <value, or null to remove>}} (scope posts.meta:write). posts.set_terms changes a post's terms in one taxonomy by slug (scope posts.terms:write).
- Fixture posts are created within the last two hours, and modified when created.`;
