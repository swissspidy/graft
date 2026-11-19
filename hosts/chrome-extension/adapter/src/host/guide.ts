import type { HostGuide } from '@swissspidy/graft-core';
import { a2uiNotes, chromeA2UINotes } from './a2ui.ts';

/** What the compiler needs to know about the browser host beyond the surface (for the Tasklet fixture app). */
export const hostGuide: HostGuide = {
	ui: 'A2UI',
	notes: a2uiNotes,
	fixtures: `A JSON object:
{"users": [{"as": "<alias>", "role": "owner|member|guest"}],
 "projects": [{"id": "<lowercase id>", "name": "<name>"}],
 "tasks": [{"title": "<unique title>", "project": "<project id>", "status": "open|done", "due_in_days": <days from today, negative for overdue, or null>, "assignee": "<user alias or null>"}]}
"projects" defaults to one project with id "demo"; a task's project defaults to the first project, its status to "open", its due date and assignee to none. The slot renders once per project page. view_as is a user alias from "users". App roles: guests read tasks; members and owners also mark tasks done.`,
	assertions: `{"task": {"title": "<title>", "status": "open|done"}}: the task with that title exists and has that status after the steps.`,
};

/** What the compiler needs to know about the browser's own surface (`host: chrome`), verified in an in-memory browser. */
export const chromeHostGuide: HostGuide = {
	ui: 'A2UI',
	notes: chromeA2UINotes,
	fixtures: `A JSON object:
{"tabs": [{"title": "<unique title>", "url": "<http(s) address, default https://example.com/<title>>", "pinned": <true|false, default false>, "active": <true|false, default false>, "unused_days": <days since the tab was last used, default 0>}]}
The person is always "you": use "view_as": "you", and no "users". The side panel renders once.`,
	assertions: `{"tabs": ["<title>", ...]}: exactly the tabs with these titles are open after the steps, in any order.`,
};
