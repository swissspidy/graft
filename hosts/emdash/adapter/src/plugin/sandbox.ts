import { hashSurface, type Surface } from '@graft/core';
import { baseSlot, patchSurface, resolveCall, type HostPatch } from '../host/patch.ts';
import type { PluginContext } from 'emdash';
import { roles, type RoleName } from '../host/surface.ts';
import { HostError, runCapability, usableScopes, type Viewer } from './host.ts';

/**
 * The verification sandbox protocol, served by the plugin in a throwaway
 * EmDash (the `sandbox` option, set from GRAFT_SANDBOX=1 by the test site).
 * Same operations as the WordPress sandbox: reset, seed, scopes, call,
 * slot, assert, dump, and patch (a synthetic host change for the canary,
 * see src/host/patch.ts).
 *
 * Fixture users are role-only viewers: EmDash's permission checks depend on
 * the role level and, for "own" permissions, on the entry's author. Entries
 * the plugin creates have no author, so authors cannot publish them.
 */

interface Fixtures {
	users?: Array<{ as: string; role: string }>;
	entries?: Array<{ title: string; status?: string; collection?: string }>;
}

const USERS = 'sandbox:users';
const COLLECTIONS = 'sandbox:collections';
const PATCH = 'sandbox:patch';

function api(ctx: PluginContext) {
	const content = ctx.content;
	if (!content?.create || !content.delete || !content.getVersioned || !content.publish || !content.schedule) {
		throw new Error('The sandbox needs content:write and content:publish.');
	}
	return content as Required<NonNullable<PluginContext['content']>>;
}

async function viewer(ctx: PluginContext, alias: unknown): Promise<Viewer> {
	const users = (await ctx.kv.get<Record<string, Viewer>>(USERS)) ?? {};
	const found = users[String(alias)];
	if (!found) {
		throw new Error(`No fixture user "${String(alias)}".`);
	}
	return found;
}

async function collections(ctx: PluginContext): Promise<string[]> {
	return (await ctx.kv.get<string[]>(COLLECTIONS)) ?? ['posts'];
}

async function allEntries(ctx: PluginContext, collection: string) {
	const items = [];
	let cursor: string | undefined;
	do {
		const page = await api(ctx).list(collection, { limit: 100, ...(cursor ? { cursor } : {}) });
		items.push(...page.items);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	return items;
}

export async function handleSandbox(input: unknown, ctx: PluginContext, surface: Surface): Promise<unknown> {
	const request = (input ?? {}) as Record<string, unknown>;
	const content = api(ctx);
	const patch = (await ctx.kv.get<HostPatch>(PATCH)) ?? {};
	const patched = patchSurface(surface, patch);
	switch (request.op) {
		case 'patch':
			await ctx.kv.set(PATCH, request.patch ?? {});
			return { ok: true };
		case 'reset': {
			for (const collection of new Set([...(await collections(ctx)), 'posts'])) {
				for (const item of await allEntries(ctx, collection)) {
					await content.delete(collection, item.id);
				}
			}
			await ctx.kv.set(USERS, {});
			await ctx.kv.set(COLLECTIONS, ['posts']);
			return { ok: true };
		}
		case 'seed': {
			const fixtures = (request.fixtures ?? {}) as Fixtures;
			const users: Record<string, Viewer> = {};
			const out: Record<string, string[]> = {};
			for (const user of fixtures.users ?? []) {
				const level = roles[user.role as RoleName];
				if (level === undefined) {
					return { error: `Unknown role "${user.role}". Roles: ${Object.keys(roles).join(', ')}.` };
				}
				users[user.as] = { id: `sandbox-${user.as}`, role: level };
				out[user.as] = [user.role];
			}
			await ctx.kv.set(USERS, users);
			const used = new Set(['posts']);
			// Oldest first, as listed; distinct update times keep ordering stable.
			for (const entry of fixtures.entries ?? []) {
				const collection = entry.collection ?? 'posts';
				let item;
				try {
					item = await content.create(collection, { title: entry.title });
				} catch (error) {
					// Usually a collection the site does not have; the test site only has posts.
					await ctx.kv.set(COLLECTIONS, [...used]);
					return { error: `Entry "${entry.title}" cannot be created in "${collection}": ${error instanceof Error ? error.message : String(error)}` };
				}
				used.add(collection);
				const status = entry.status ?? 'published';
				if (status === 'published' || status === 'scheduled') {
					const versioned = await content.getVersioned(collection, item.id);
					if (status === 'published') {
						await content.publish(collection, item.id, { _rev: versioned!._rev });
					} else {
						const at = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
						await content.schedule(collection, item.id, { scheduledAt: at, _rev: versioned!._rev });
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			await ctx.kv.set(COLLECTIONS, [...used]);
			return { users: out };
		}
		case 'scopes':
			return { scopes: usableScopes(await viewer(ctx, request.as), (request.scopes as string[]) ?? [], patched.scopes) };
		case 'call': {
			try {
				const who = await viewer(ctx, request.as);
				const name = String(request.capability);
				const resolved = resolveCall(patch, name, (request.input ?? {}) as Record<string, unknown>);
				if (!resolved || !patched.capabilities[name]) {
					throw new HostError('graft_unknown_capability', `This host has no "${name}".`);
				}
				for (const scope of patched.capabilities[name]!.scopes) {
					if (!usableScopes(who, [scope], patched.scopes)[scope]) {
						throw new HostError('graft_forbidden', `Your role cannot use "${scope}".`);
					}
				}
				const result = await runCapability(ctx, who, resolved.name, resolved.input, resolved.statuses ? { statuses: resolved.statuses } : {});
				return { result };
			} catch (error) {
				const code = error instanceof HostError ? error.code : 'graft_host_error';
				return { error: { code, message: error instanceof Error ? error.message : String(error) } };
			}
		}
		case 'slot': {
			if (!patched.slots[String(request.slot)]) {
				return { instances: [] };
			}
			const slot = baseSlot(patch, String(request.slot));
			if (slot !== 'content.editor.panel') {
				return { instances: [{}] };
			}
			// One panel per entry the viewer can open in the editor.
			const who = await viewer(ctx, request.as);
			const instances = [];
			for (const collection of await collections(ctx)) {
				for (const item of await allEntries(ctx, collection)) {
					try {
						instances.push({ entry: await runCapability(ctx, who, 'content.get', { collection, id: item.id }) });
					} catch {
						// not visible to this viewer
					}
				}
			}
			return { instances };
		}
		case 'assert': {
			if (request.kind !== 'entry') {
				return { ok: false, actual: `Unknown assertion "${String(request.kind)}".` };
			}
			const expected = (request.expected ?? {}) as { title?: string; status?: string; collection?: string };
			const items = await allEntries(ctx, expected.collection ?? 'posts');
			const item = items.find((i) => i.data.title === expected.title);
			const actual = item ? { title: item.data.title, status: item.status } : null;
			return { ok: !!item && (expected.status === undefined || item.status === expected.status), actual };
		}
		case 'dump':
			return { surface: { ...patched, hash: await hashSurface(patched) } };
		default:
			throw new Error(`Unknown sandbox op "${String(request.op)}".`);
	}
}
