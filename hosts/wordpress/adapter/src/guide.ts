import type { HostGuide } from '@swissspidy/graft-core';
import { a2uiNotes } from './a2ui.ts';

/** What the compiler needs to know about WordPress beyond the surface. */
export const hostGuide: HostGuide = {
	ui: 'A2UI',
	notes: a2uiNotes,
	fixtures: `A JSON object:
{"users": [{"as": "<alias>", "role": "administrator|editor|author|contributor|subscriber", "name": "<display name, optional; default the alias with its first letter capitalized>"}],
 "posts": [{"title": "<unique title>", "status": "publish|future|draft|pending|private", "author": "<user alias, optional; default the site admin>", "excerpt": "<optional>",
   "type": "<optional post type from the surface's model; default post>", "meta": {"<exposed field>": <value>}, "terms": {"<taxonomy>": ["<term slug>"]}}],
 "terms": {"<taxonomy>": [{"name": "<name>", "slug": "<slug>"}]}}
"terms" creates terms up front (a post's term slugs are created when missing, named after the slug). The site's post types, fields and taxonomies are those in the surface's "model"; nothing else exists.
The site has no other posts and no users besides the admin. Posts are created oldest first, in list order. view_as is a user alias from "users". Pages show users by display name (e.g. a post's author.name), never by alias. Remember WordPress permissions: authors and above publish their own posts, editors and administrators publish anyone's, contributors publish nothing and only see their own unpublished posts.`,
	assertions: `{"post": {"title": "<title>", "status": "<status>", "excerpt": "<excerpt>", "meta": {"<field>": <value or null for none>}, "terms": {"<taxonomy>": ["<slug>"]}}}: the post with that title exists and has those fields (any of status, excerpt, meta, terms; terms compares the whole set of slugs in each taxonomy given) after the steps.`,
};
