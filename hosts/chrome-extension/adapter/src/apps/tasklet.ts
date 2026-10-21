import type { JsonSchema } from '@swissspidy/graft-core';
import { pageProps, type AppDescription } from '../host/surface.ts';

/**
 * Tasklet (hosts/chrome-extension/fixtures/tasklet), described from the
 * outside the way an adapter author describes an app they do not own:
 * where its project pages can take a customization, which of its API
 * endpoints customizations may call, and which of its roles may do what.
 */

const PROJECT_PAGES = ['/projects/:project'];

const task: JsonSchema = {
	type: 'object',
	properties: {
		id: { type: 'string' },
		title: { type: 'string' },
		status: { enum: ['open', 'done'] },
		due: { description: 'Due date (YYYY-MM-DD), or null.', type: ['string', 'null'] },
		assignee: {
			type: ['object', 'null'],
			properties: { id: { type: 'string' }, name: { type: 'string' } },
			required: ['id', 'name'],
			additionalProperties: false,
		},
	},
	required: ['id', 'title', 'status', 'due', 'assignee'],
	additionalProperties: false,
};

const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } as const;

export const tasklet: AppDescription = {
	id: 'tasklet',
	title: 'Tasklet',
	// The fixture app runs on 127.0.0.1 on any port; a real app names its origin, e.g. https://app.tasklet.example/*.
	origins: ['http://127.0.0.1/*'],
	roles: ['guest', 'member', 'owner'],
	viewer: { binding: { method: 'GET', path: '/api/me' }, role: '/role' },
	slots: {
		'project.sidebar': {
			kind: 'extension',
			title: 'Project sidebar',
			description: "A section at the end of a project page's details sidebar.",
			screen: 'project',
			options: {
				type: 'object',
				properties: { title: { type: 'string', minLength: 1, maxLength: 60 } },
				required: ['title'],
				additionalProperties: false,
			},
			provides: pageProps(PROJECT_PAGES),
			at: {
				pages: PROJECT_PAGES,
				selectors: ['[data-testid="project-sidebar"]'],
				landmark: { role: 'complementary', name: 'Project details' },
				insert: 'append',
			},
		},
		'project.toolbar': {
			kind: 'extension',
			title: 'Project toolbar',
			description: "Buttons after the project's own actions, under its title.",
			screen: 'project',
			options: { type: 'object', properties: {}, additionalProperties: false },
			provides: pageProps(PROJECT_PAGES),
			at: {
				pages: PROJECT_PAGES,
				selectors: ['[data-testid="project-toolbar"]'],
				landmark: { role: 'toolbar', name: 'Project actions' },
				insert: 'append',
			},
		},
	},
	capabilities: {
		'tasks.list': {
			kind: 'read',
			description: 'Tasks of a project, optionally only open or done ones, or only those assigned to the viewer ("me").',
			input: {
				type: 'object',
				properties: { project: id, status: { enum: ['open', 'done'] }, assignee: { const: 'me' } },
				required: ['project'],
				additionalProperties: false,
			},
			output: {
				type: 'object',
				properties: { tasks: { type: 'array', items: task } },
				required: ['tasks'],
				additionalProperties: false,
			},
			scopes: ['tasks:read'],
			binding: { method: 'GET', path: '/api/projects/{project}/tasks', query: ['status', 'assignee'] },
		},
		'tasks.complete': {
			kind: 'write',
			description: 'Marks a task done.',
			input: { type: 'object', properties: { id }, required: ['id'], additionalProperties: false },
			output: task,
			scopes: ['tasks.status:write'],
			binding: { method: 'POST', path: '/api/tasks/{id}/complete', headers: { 'X-Requested-With': 'tasklet' } },
		},
		'members.list': {
			kind: 'read',
			description: 'Everyone in the workspace, with their email address.',
			input: { type: 'object', properties: {}, additionalProperties: false },
			output: {
				type: 'object',
				properties: {
					members: {
						type: 'array',
						items: {
							type: 'object',
							properties: { id: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, email: { type: 'string' } },
							required: ['id', 'name', 'role', 'email'],
							additionalProperties: false,
						},
					},
				},
				required: ['members'],
				additionalProperties: false,
			},
			scopes: ['members:read'],
			binding: { method: 'GET', path: '/api/members' },
		},
	},
	scopes: {
		'tasks:read': { title: "See a project's tasks", host: ['guest', 'member', 'owner'] },
		'tasks.status:write': { title: 'Mark tasks done', host: ['member', 'owner'] },
		'members:read': { title: "See everyone's name and email address", host: ['member', 'owner'] },
	},
};

/** Where the drift probe looks in Tasklet, signed in as a member (fixture data; a real app's probes are a maintainer's own pages). */
export const taskletProbes = {
	session: '/login?as=ada',
	pages: { 'project.sidebar': '/projects/launch', 'project.toolbar': '/projects/launch' },
	inputs: { 'tasks.list': { project: 'launch' }, 'members.list': {} },
};
