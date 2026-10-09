import type { HostGuide } from '@graft/core';
import { a2uiNotes } from './a2ui.ts';

/** What the compiler needs to know about EmDash beyond the surface. */
export const hostGuide: HostGuide = {
	ui: 'A2UI',
	notes: a2uiNotes,
	fixtures: `A JSON object:
{"users": [{"as": "<alias>", "role": "admin|editor|author|contributor|subscriber"}],
 "entries": [{"title": "<unique title>", "status": "draft|published|scheduled", "collection": "posts"}]}
The site has no other entries, and no collection but "posts". Entries are created oldest first, in list order, and have no author, so authors cannot publish them. view_as is a user alias from "users". EmDash permissions: contributors and above read drafts; authors publish their own entries; editors and admins publish any entry; subscribers read no drafts.`,
	assertions: `{"entry": {"title": "<title>", "status": "draft|published|scheduled"}}: the entry with that title exists and has that status after the steps.`,
};
