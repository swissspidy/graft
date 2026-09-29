import { canActOnOwn, hasPermission, type Permission, type RoleLevel } from '@emdash-cms/auth';
import type { PluginContext } from 'emdash';
import { capabilities, scopes, STATUSES } from '../host/surface.ts';

/**
 * The EmDash capabilities builds call, implemented over the plugin
 * context, and the permission checks behind them. Every call runs as a
 * viewer and is checked against the viewer's EmDash role here, on top of
 * the gateway's grant checks.
 */

export interface Viewer {
	id: string;
	role: number;
}

export class HostError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'HostError';
	}
}

type Item = Awaited<ReturnType<NonNullable<PluginContext['content']>['list']>>['items'][number];

const asUser = (viewer: Viewer) => ({ id: viewer.id, role: viewer.role as RoleLevel });

/** Whether the viewer's role has any of the EmDash permissions a scope maps to. */
export function scopeUsable(viewer: Viewer, scope: string): boolean {
	const host = scopes[scope]?.host ?? [];
	return host.length > 0 && host.some((permission) => hasPermission(asUser(viewer), permission as Permission));
}

export function usableScopes(viewer: Viewer, wanted: string[]): Record<string, boolean> {
	return Object.fromEntries(wanted.map((scope) => [scope, scopeUsable(viewer, scope)]));
}

function canPublish(viewer: Viewer, item: Item): boolean {
	return canActOnOwn(asUser(viewer), item.authorId ?? '', 'content:publish_own', 'content:publish_any');
}

/** "published" for live entries, whatever their draft state. */
function status(item: Item): (typeof STATUSES)[number] {
	return (STATUSES as readonly string[]).includes(item.status) ? (item.status as (typeof STATUSES)[number]) : 'draft';
}

async function authorOf(ctx: PluginContext, item: Item, names: Map<string, string>): Promise<{ id: string; name: string } | null> {
	if (!item.authorId) {
		return null;
	}
	if (!names.has(item.authorId)) {
		const user = await ctx.users?.get(item.authorId);
		names.set(item.authorId, user?.name || user?.email || item.authorId);
	}
	return { id: item.authorId, name: names.get(item.authorId)! };
}

async function toEntry(ctx: PluginContext, viewer: Viewer, collection: string, item: Item, names = new Map<string, string>()) {
	const title = item.data.title;
	return {
		id: item.id,
		collection,
		title: typeof title === 'string' ? title : (item.slug ?? item.id),
		slug: item.slug,
		status: status(item),
		author: await authorOf(ctx, item, names),
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		publishedAt: item.publishedAt,
		can: { publish: canPublish(viewer, item) },
	};
}

export type Entry = Awaited<ReturnType<typeof toEntry>>;

function content(ctx: PluginContext) {
	if (!ctx.content) {
		throw new HostError('graft_host_unavailable', 'The Graft plugin cannot read content.');
	}
	return ctx.content;
}

async function load(ctx: PluginContext, viewer: Viewer, collection: string, id: string): Promise<Item> {
	const item = await content(ctx).get(collection, id);
	if (!item) {
		throw new HostError('graft_not_found', `No ${collection} entry "${id}".`);
	}
	// Drafts are only visible to roles that may read drafts.
	if (item.status !== 'published' && !hasPermission(asUser(viewer), 'content:read_drafts')) {
		throw new HostError('graft_not_found', `No ${collection} entry "${id}".`);
	}
	return item;
}

async function changeStatus(ctx: PluginContext, viewer: Viewer, input: { collection?: string; id: string }, to: 'publish' | 'unpublish') {
	const collection = input.collection ?? 'posts';
	const item = await load(ctx, viewer, collection, input.id);
	if (!canPublish(viewer, item)) {
		throw new HostError('graft_forbidden', `You may not ${to} "${String(item.data.title ?? item.id)}".`);
	}
	const api = content(ctx);
	const versioned = await api.getVersioned?.(collection, input.id);
	const change = to === 'publish' ? api.publish : api.unpublish;
	if (!versioned || !change) {
		throw new HostError('graft_host_unavailable', `The Graft plugin cannot ${to} content.`);
	}
	await change.call(api, collection, input.id, { _rev: versioned._rev });
	return toEntry(ctx, viewer, collection, (await api.get(collection, input.id))!);
}

type Input = Record<string, unknown>;

/** Runs a capability as a viewer. Input has been validated against the surface. */
export async function runCapability(ctx: PluginContext, viewer: Viewer, name: string, input: Input): Promise<unknown> {
	const capability = capabilities[name];
	if (!capability) {
		throw new HostError('graft_unknown_capability', `Unknown capability "${name}".`);
	}
	for (const scope of capability.scopes) {
		if (!scopeUsable(viewer, scope)) {
			throw new HostError('graft_forbidden', `Your role cannot use "${scopes[scope]?.title ?? scope}".`);
		}
	}
	const collection = typeof input.collection === 'string' ? input.collection : 'posts';
	switch (name) {
		case 'content.list': {
			const limit = typeof input.limit === 'number' ? input.limit : 20;
			const where = typeof input.status === 'string' ? { status: input.status } : undefined;
			const result = await content(ctx).list(collection, {
				limit,
				orderBy: { updatedAt: input.order === 'asc' ? 'asc' : 'desc' },
				...(where ? { where } : {}),
			});
			const names = new Map<string, string>();
			const items = [];
			for (const item of result.items) {
				items.push(await toEntry(ctx, viewer, collection, item, names));
			}
			return { items, hasMore: result.hasMore };
		}
		case 'content.get':
			return toEntry(ctx, viewer, collection, await load(ctx, viewer, collection, String(input.id)));
		case 'content.publish':
			return changeStatus(ctx, viewer, input as { collection?: string; id: string }, 'publish');
		case 'content.unpublish':
			return changeStatus(ctx, viewer, input as { collection?: string; id: string }, 'unpublish');
		default:
			throw new HostError('graft_unknown_capability', `"${name}" is not implemented.`);
	}
}
