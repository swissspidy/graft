import { hasPermission } from '../host/permissions.ts';
import { compileSchema, evaluate, extractRefs, validateSpec, type Build, type Surface } from '@graft/core';
import { findAction, renderTree, type Block, type Rendered } from '../host/blocks.ts';
import { createCan } from '../host/can.ts';
import { roleName } from '../host/surface.ts';
import { HostError, runCapability, usableScopes, type Viewer } from './host.ts';
import { activeVersion, pendingVersion, type SpecRecord, type Store, type Version } from './store.ts';
import { describeVersion } from './describe.ts';
import { authoringAction, authoringBlocks, type Authoring, type AuthoringResult } from './author-ui.ts';
import type { PluginContext } from 'emdash';

/**
 * Serves active customizations as Block Kit: the admin page, the dashboard
 * widget and the entry editor panel. Everything is rendered on the server
 * for the viewer; a button click comes back as an action id and a row id,
 * and the action is found again in a fresh render, so the browser never
 * names a capability or its input. Each call then passes the gateway: the
 * build must use the capability, the grant must cover its scopes, the
 * input must match its schema, and the viewer's role must allow it.
 */

export interface Response {
	blocks: Block[];
	toast?: { message: string; type: 'success' | 'error' | 'info' };
}

export interface Served {
	record: SpecRecord;
	version: Version;
	build: Build;
	audience: string[];
	title: string;
}

export type Call = (capability: string, input: unknown) => Promise<unknown>;


/** Active customizations whose build targets the current surface. */
export async function servable(store: Store, surface: Surface): Promise<Served[]> {
	const served: Served[] = [];
	for (const record of await store.list()) {
		const version = activeVersion(record);
		if (!version?.build || version.build.surface.hash !== surface.hash) {
			continue;
		}
		const manifest = validateSpec(version.source).spec?.manifest;
		const mount = version.build.mount as { title?: string };
		served.push({ record, version, build: version.build, audience: manifest?.audience ?? [], title: mount.title ?? record.title });
	}
	return served;
}

export function inAudience(served: Served, viewer: Viewer): boolean {
	const role = roleName(viewer.role);
	return served.audience.length === 0 || (role !== undefined && served.audience.includes(role));
}

/** The gateway for one customization and viewer. */
export function gateway(ctx: PluginContext, viewer: Viewer, served: Served, surface: Surface): Call {
	const used = new Set(extractRefs(served.build, surface).capabilities);
	return async (capability, input) => {
		const declared = surface.capabilities[capability];
		if (!declared || !used.has(capability)) {
			throw new HostError('graft_capability_not_in_build', `This customization does not use "${capability}".`);
		}
		if (!declared.scopes.every((scope) => served.record.grant.includes(scope))) {
			throw new HostError('graft_not_granted', `"${capability}" needs a permission that was not approved.`);
		}
		const validate = compileSchema(declared.input as object);
		const value = input ?? {};
		if (!validate(value)) {
			throw new HostError('graft_invalid_input', `Invalid input for "${capability}".`);
		}
		return runCapability(ctx, viewer, capability, value as Record<string, unknown>);
	};
}

interface Instance {
	served: Served;
	slot: Record<string, unknown>;
}

/** Renders one customization in one place; data that fails to load is reported inline. */
async function renderInstance(ctx: PluginContext, viewer: Viewer, instance: Instance, surface: Surface): Promise<Rendered & { call: Call }> {
	const { served, slot } = instance;
	const call = gateway(ctx, viewer, served, surface);
	const usable = usableScopes(viewer, served.record.grant);
	const can = createCan(usable);
	const data: Record<string, unknown> = {};
	const errors: string[] = [];
	for (const [name, source] of Object.entries(served.build.data)) {
		try {
			data[name] = await call(source.call, evaluate(source.input, { data: {}, slot, can }) ?? null);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	const rendered = renderTree(served.build.tree, { data, slot, can }, served.record.id);
	if (errors.length > 0) {
		rendered.blocks.unshift({ type: 'banner', variant: 'error', title: 'Some data could not be loaded', description: errors.join(' ') });
	}
	return { ...rendered, call };
}

async function renderAll(ctx: PluginContext, viewer: Viewer, instances: Instance[], surface: Surface, titled: boolean) {
	const blocks: Block[] = [];
	const renders = [];
	for (const instance of instances) {
		const rendered = await renderInstance(ctx, viewer, instance, surface);
		renders.push({ instance, rendered });
		if (titled) {
			if (blocks.length > 0) {
				blocks.push({ type: 'divider' });
			}
			blocks.push({ type: 'header', text: instance.served.title });
		}
		blocks.push(...rendered.blocks);
	}
	return { blocks, renders };
}

/**
 * Handles a click: finds the action in a fresh render, runs it through the
 * gateway and returns the notice. Every `then` re-renders from fresh data
 * (the server keeps no view state).
 */
async function act(ctx: PluginContext, viewer: Viewer, instances: Instance[], surface: Surface, actionId: string, value: unknown): Promise<Response['toast']> {
	const specId = actionId.split(':')[0];
	for (const instance of instances.filter((i) => i.served.record.id === specId)) {
		const rendered = await renderInstance(ctx, viewer, instance, surface);
		const found = findAction(rendered, actionId, value);
		if (!found?.action) {
			continue;
		}
		try {
			await rendered.call(found.action.capability, found.action.input);
		} catch (error) {
			return { message: error instanceof Error ? error.message : String(error), type: 'error' };
		}
		return { message: found.action.notice ?? 'Done.', type: 'success' };
	}
	return { message: 'That action is no longer available.', type: 'error' };
}

export interface Interaction {
	type: string;
	page?: string;
	action_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}

const isAdmin = (viewer: Viewer) => hasPermission(viewer, 'plugins:manage');

/** The Manage tab, for administrators: writing new customizations, and every customization with its state. */
async function manage(store: Store, surface: Surface, authoring: Authoring | undefined, result: AuthoringResult | undefined): Promise<Block[]> {
	const blocks: Block[] = authoring ? await authoringBlocks(authoring, result) : [];
	const records = await store.list();
	if (blocks.length > 0) {
		blocks.push({ type: 'divider' }, { type: 'header', text: 'Customizations' });
	}
	if (records.length === 0) {
		blocks.push({ type: 'empty', title: 'No customizations yet', description: authoring ? 'Write one above, or install one with graft site install.' : 'Install one with graft site install.' });
		return blocks;
	}
	for (const [i, record] of records.entries()) {
		if (i > 0) {
			blocks.push({ type: 'divider' });
		}
		blocks.push(...describeVersion(record, surface));
		const pending = pendingVersion(record);
		if (pending) {
			blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: 'graft:approve', value: record.id, label: `Approve version ${pending.n}`, style: 'primary' }] });
		}
	}
	return blocks;
}

export interface ServeOptions {
	ctx: PluginContext;
	viewer: Viewer;
	store: Store;
	surface: Surface;
	/** Writing customizations in the admin; absent where it is not offered. */
	authoring?: Authoring;
}

/** The admin route: plugin pages and the dashboard widget. */
export async function serveAdmin({ ctx, viewer, store, surface, authoring }: ServeOptions, interaction: Interaction, where: 'admin-page' | 'dashboard-widget'): Promise<Response> {
	const served = await servable(store, surface);
	let toast: Response['toast'];

	if (where === 'dashboard-widget') {
		const instances = served.filter((s) => s.build.mount.slot === 'dashboard.widget' && inAudience(s, viewer)).map((s) => ({ served: s, slot: {} }));
		if (interaction.type === 'block_action' && interaction.action_id) {
			toast = await act(ctx, viewer, instances, surface, interaction.action_id, interaction.value);
		}
		const { blocks } = await renderAll(ctx, viewer, instances, surface, true);
		return withToast({ blocks: blocks.length > 0 ? blocks : [{ type: 'context', text: 'No customizations here yet.' }] }, toast);
	}

	// The Customizations page: a tab per admin page customization, and
	// for administrators a Manage tab. EmDash only serves declared plugin
	// pages, so customizations cannot have pages of their own.
	const pageInstances = (list: Served[]) => list.filter((s) => s.build.mount.slot === 'admin.page' && inAudience(s, viewer)).map((s) => ({ served: s, slot: {} }));
	let instances = pageInstances(served);
	let open = 0;
	const authored = authoring && isAdmin(viewer) ? await authoringAction(authoring, { store, surface }, interaction) : undefined;
	if (authored) {
		toast = authored.toast;
		open = instances.length; // the Manage tab
	} else if (interaction.type === 'block_action' && interaction.action_id === 'graft:approve') {
		if (!isAdmin(viewer)) {
			toast = { message: 'Only administrators approve customizations.', type: 'error' };
		} else {
			try {
				await store.approve(String(interaction.value));
				toast = { message: 'Approved.', type: 'success' };
			} catch (error) {
				toast = { message: error instanceof Error ? error.message : String(error), type: 'error' };
			}
		}
		instances = pageInstances(await servable(store, surface));
		open = instances.length; // the Manage tab
	} else if (interaction.type === 'block_action' && interaction.action_id) {
		toast = await act(ctx, viewer, instances, surface, interaction.action_id, interaction.value);
		open = Math.max(0, instances.findIndex((i) => i.served.record.id === interaction.action_id!.split(':')[0]));
	}
	const panels: Array<{ label: string; blocks: Block[] }> = [];
	for (const instance of instances) {
		const { blocks } = await renderAll(ctx, viewer, [instance], surface, false);
		panels.push({ label: instance.served.title, blocks });
	}
	if (isAdmin(viewer)) {
		panels.push({ label: 'Manage', blocks: await manage(store, surface, authoring, authored) });
	}
	if (panels.length === 0) {
		return withToast({ blocks: [{ type: 'empty', title: 'No customizations for you yet' }] }, toast);
	}
	const blocks: Block[] = panels.length === 1 ? panels[0]!.blocks : [{ type: 'tab', panels, default_tab: Math.min(open, panels.length - 1) }];
	return withToast({ blocks }, toast);
}

/** The editor panel route, for a saved entry. */
export async function servePanel(
	{ ctx, viewer, store, surface }: ServeOptions,
	interaction: Interaction,
	entry: { collection: string; id: string },
): Promise<Response> {
	const served = (await servable(store, surface)).filter((s) => {
		const collections = (s.build.mount as { collections?: string[] }).collections;
		return s.build.mount.slot === 'content.editor.panel' && inAudience(s, viewer) && (!collections || collections.includes(entry.collection));
	});
	if (served.length === 0) {
		return { blocks: [{ type: 'context', text: 'No customizations for this entry.' }] };
	}
	let slotEntry: unknown;
	try {
		slotEntry = await runCapability(ctx, viewer, 'content.get', { collection: entry.collection, id: entry.id });
	} catch {
		return { blocks: [{ type: 'context', text: 'No customizations for this entry.' }] };
	}
	const instances = served.map((s) => ({ served: s, slot: { entry: slotEntry } }));
	let toast: Response['toast'];
	if (interaction.type === 'block_action' && interaction.action_id) {
		toast = await act(ctx, viewer, instances, surface, interaction.action_id, interaction.value);
		if (toast?.type === 'success') {
			const fresh = await runCapability(ctx, viewer, 'content.get', { collection: entry.collection, id: entry.id });
			instances.forEach((i) => (i.slot = { entry: fresh }));
		}
	}
	const { blocks } = await renderAll(ctx, viewer, instances, surface, served.length > 1);
	return withToast({ blocks }, toast);
}

function withToast(response: Response, toast: Response['toast']): Response {
	return toast ? { ...response, toast } : response;
}
