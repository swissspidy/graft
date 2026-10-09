import type { Capability, JsonSchema, Scope, Slot, Surface } from '@graft/core';

/**
 * The EmDash host surface: where builds mount, what they may call and the
 * scopes an admin grants. Scopes map to EmDash's own RBAC permissions
 * (@emdash-cms/auth), which the gateway checks for the viewer on every
 * call.
 */

export const STATUSES = ['draft', 'published', 'scheduled'] as const;

const entry: JsonSchema = {
	type: 'object',
	properties: {
		id: { type: 'string' },
		collection: { type: 'string' },
		title: { type: 'string' },
		slug: { type: ['string', 'null'] },
		status: { enum: [...STATUSES] },
		author: {
			type: ['object', 'null'],
			properties: { id: { type: 'string' }, name: { type: 'string' } },
			required: ['id', 'name'],
			additionalProperties: false,
		},
		createdAt: { type: 'string', format: 'date-time' },
		updatedAt: { type: 'string', format: 'date-time' },
		publishedAt: { type: ['string', 'null'], format: 'date-time' },
		can: {
			description: 'What the current user may do with this entry.',
			type: 'object',
			properties: { publish: { type: 'boolean' } },
			required: ['publish'],
			additionalProperties: false,
		},
	},
	required: ['id', 'collection', 'title', 'status', 'can'],
	additionalProperties: false,
};

const collection: JsonSchema = {
	description: 'Collection slug, e.g. "posts".',
	type: 'string',
	pattern: '^[a-z][a-z0-9_]*$',
	default: 'posts',
};

const ref: JsonSchema = {
	type: 'object',
	properties: { collection, id: { type: 'string', minLength: 1 } },
	required: ['id'],
	additionalProperties: false,
};

export const capabilities: Record<string, Capability> = {
	'content.list': {
		kind: 'read',
		description: 'Lists entries of a collection, newest first unless "order" says otherwise.',
		input: {
			type: 'object',
			properties: {
				collection,
				status: { enum: [...STATUSES] },
				order: { description: 'By last update.', enum: ['asc', 'desc'], default: 'desc' },
				limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
			},
			additionalProperties: false,
		},
		output: {
			type: 'object',
			properties: { items: { type: 'array', items: entry }, hasMore: { type: 'boolean' } },
			required: ['items', 'hasMore'],
			additionalProperties: false,
		},
		scopes: ['content:read'],
		binding: { content: 'list' },
	},
	'content.get': {
		kind: 'read',
		description: 'One entry.',
		input: ref,
		output: entry,
		scopes: ['content:read'],
		binding: { content: 'get' },
	},
	'content.publish': {
		kind: 'write',
		description: 'Publishes an entry: its current draft goes live.',
		input: ref,
		output: entry,
		scopes: ['content.status:write'],
		binding: { content: 'publish' },
	},
	'content.unpublish': {
		kind: 'write',
		description: 'Takes a published entry offline; it becomes a draft.',
		input: ref,
		output: entry,
		scopes: ['content.status:write'],
		binding: { content: 'unpublish' },
	},
};

export const scopes: Record<string, Scope> = {
	'content:read': {
		title: 'See content, including drafts',
		host: ['content:read_drafts'],
	},
	'content.status:write': {
		title: 'Publish and unpublish content',
		host: ['content:publish_own', 'content:publish_any'],
	},
};

const empty: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };
const title = (max: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength: max });

export const slots: Record<string, Slot> = {
	'admin.page': {
		kind: 'owned',
		title: 'Admin page',
		description: 'A tab of its own on the Customizations page of the EmDash admin.',
		anchor: 'plugin-admin-page',
		options: { type: 'object', properties: { title: title(40) }, required: ['title'], additionalProperties: false },
		provides: empty,
	},
	'dashboard.widget': {
		kind: 'owned',
		title: 'Dashboard widget',
		description: 'A section of the Customizations widget on the EmDash dashboard.',
		screen: 'dashboard',
		anchor: 'plugin-dashboard-widget',
		options: { type: 'object', properties: { title: title(60) }, required: ['title'], additionalProperties: false },
		provides: empty,
	},
	'content.editor.panel': {
		kind: 'extension',
		title: 'Entry editor panel',
		description: 'A section of the Customizations panel in the sidebar of the entry editor, for saved entries.',
		screen: 'content-editor',
		anchor: 'plugin-editor-panel',
		options: {
			type: 'object',
			properties: {
				collections: { description: 'Collections whose editor shows it. Omit for all.', type: 'array', items: collection, uniqueItems: true },
			},
			additionalProperties: false,
		},
		provides: { type: 'object', properties: { entry }, required: ['entry'], additionalProperties: false },
	},
};

/** EmDash role names, lowest first, and their levels (@emdash-cms/auth Role). */
export const roles = { subscriber: 10, contributor: 20, author: 30, editor: 40, admin: 50 } as const;
export type RoleName = keyof typeof roles;

export function roleName(level: number): RoleName | undefined {
	return (Object.keys(roles) as RoleName[]).find((name) => roles[name] === level);
}

/** The EmDash surface for an EmDash version. */
export function hostSurface(hostVersion: string): Surface {
	return {
		graft: 1,
		host: 'emdash',
		hostVersion,
		slots,
		capabilities,
		scopes,
		audiences: Object.keys(roles),
	};
}
