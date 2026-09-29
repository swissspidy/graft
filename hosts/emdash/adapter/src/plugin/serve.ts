import { hasPermission } from '../host/permissions.ts';
import { compileSchema, evaluate, extractRefs, inert, updateArgs, validateSpec, validateWidgetTree, type Build, type BuildCode, type FunctionRunner, type Surface, type SurfaceFunctions } from '@graft/core';
import { findAction, readValue, renderTree, withWidgetStates, type Block, type Rendered } from '../host/blocks.ts';
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
 *
 * Build functions run here too, in QuickJS (see LoadFunctions), and so do
 * widgets: their states travel in the buttons' values (blocks.ts).
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

/** Starts a sandbox for a build's code: @graft/sandbox, in the build the runtime can run. */
export type LoadFunctions = (code: BuildCode, limits: SurfaceFunctions['limits']) => Promise<FunctionRunner>;

/**
 * Sandboxes by code, kept while the process lives: a site has few builds
 * with code, and they change only with a new version. A load that fails is
 * forgotten, so the next render tries again.
 */
const runners = new Map<string, Promise<FunctionRunner>>();

function functionsFor(code: BuildCode, limits: SurfaceFunctions['limits'], load: LoadFunctions): Promise<FunctionRunner> {
	const key = JSON.stringify([code.source, code.functions, limits]);
	let runner = runners.get(key);
	if (!runner) {
		runner = load(code, limits);
		runners.set(key, runner);
		runner.catch(() => runners.delete(key));
	}
	return runner;
}

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

/** Widget states by customization (its spec id), then by node path. */
export type WidgetStates = Record<string, Record<string, unknown>>;

type InstanceRender = Rendered & {
	call: Call;
	/** Runs one of the build's functions; a failure returns null and is added to `failures`. */
	fn?: (name: string, args: unknown[]) => unknown;
	failures: string[];
};

/** Renders one customization in one place; data that fails to load and widgets that fail to draw are reported inline. */
async function renderInstance(ctx: PluginContext, viewer: Viewer, instance: Instance, surface: Surface, load: LoadFunctions | undefined, states: Record<string, unknown> = {}): Promise<InstanceRender> {
	const { served, slot } = instance;
	const call = gateway(ctx, viewer, served, surface);
	const usable = usableScopes(viewer, served.record.grant);
	const can = createCan(usable);
	const now = Date.now();
	const data: Record<string, unknown> = {};
	const errors: string[] = [];
	for (const [name, source] of Object.entries(served.build.data)) {
		try {
			data[name] = await call(source.call, evaluate(source.input, { data: {}, slot, can, now }) ?? null);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	const failures: string[] = [];
	let functions: FunctionRunner | undefined;
	const code = served.build.code;
	if (code && surface.functions && load) {
		try {
			functions = await functionsFor(code, surface.functions.limits, load);
		} catch (error) {
			failures.push(`The customization's code does not load: ${error instanceof Error ? error.message : String(error)}.`);
		}
	}
	const fn = functions
		? (name: string, args: unknown[]): unknown => {
				try {
					return functions.call(name, args, now);
				} catch (error) {
					const failure = `Function "${name}" failed: ${error instanceof Error ? error.message : String(error)}.`;
					if (!failures.includes(failure)) {
						failures.push(failure);
					}
					return null;
				}
			}
		: undefined;
	const widgets = surface.functions?.widgets ? { limits: surface.functions.widgets, states, validate: (tree: Build['tree']) => validateWidgetTree(tree, surface) } : undefined;
	const rendered = withWidgetStates(renderTree(served.build.tree, { data, slot, can, now, ...(fn ? { fn } : {}) }, served.record.id, widgets), served.record.id);
	if (errors.length > 0) {
		rendered.blocks.unshift({ type: 'banner', variant: 'error', title: 'Some data could not be loaded', description: errors.join(' ') });
	}
	const problems = [...failures, ...rendered.problems];
	if (problems.length > 0) {
		rendered.blocks.unshift({ type: 'banner', variant: 'error', title: 'Some of this could not be drawn', description: problems.join(' ') });
	}
	return { ...rendered, call, failures, ...(fn ? { fn } : {}) };
}

async function renderAll(ctx: PluginContext, viewer: Viewer, instances: Instance[], surface: Surface, load: LoadFunctions | undefined, titled: boolean, states: WidgetStates = {}) {
	const blocks: Block[] = [];
	const renders = [];
	for (const instance of instances) {
		const rendered = await renderInstance(ctx, viewer, instance, surface, load, states[instance.served.record.id]);
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
 * Handles a click: finds the button in a fresh render (with the widget
 * states it carried) and either runs its action through the gateway, or,
 * for a widget's event, computes the widget's next state. Returns the
 * notice and the widget states to render with. Every `then` re-renders
 * from fresh data (the server keeps no view state).
 */
async function act(
	ctx: PluginContext,
	viewer: Viewer,
	instances: Instance[],
	surface: Surface,
	load: LoadFunctions | undefined,
	actionId: string,
	sent: unknown,
): Promise<{ toast?: Response['toast']; states: WidgetStates }> {
	const specId = actionId.split(':')[0]!;
	const { value, states } = readValue(sent);
	const kept = { [specId]: states };
	for (const instance of instances.filter((i) => i.served.record.id === specId)) {
		const rendered = await renderInstance(ctx, viewer, instance, surface, load, states);
		const found = findAction(rendered, actionId, value);
		if (found?.event) {
			const drawn = rendered.widgets[found.event.widget];
			if (!drawn?.props.update || !rendered.fn) {
				return { toast: { message: 'That button does nothing.', type: 'error' }, states: kept };
			}
			const failed = rendered.failures.length;
			const next = rendered.fn(drawn.props.update, updateArgs(drawn.props, drawn.state, { $event: found.event.name, payload: found.event.payload }));
			if (rendered.failures.length > failed) {
				return { toast: { message: rendered.failures.at(-1)!, type: 'error' }, states: kept };
			}
			return { states: { [specId]: { ...states, [found.event.widget]: inert(next) } } };
		}
		if (!found?.action) {
			continue;
		}
		try {
			await rendered.call(found.action.capability, found.action.input);
		} catch (error) {
			return { toast: { message: error instanceof Error ? error.message : String(error), type: 'error' }, states: kept };
		}
		return { toast: { message: found.action.notice ?? 'Done.', type: 'success' }, states: kept };
	}
	return { toast: { message: 'That action is no longer available.', type: 'error' }, states: kept };
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
	/** Runs builds' functions and widgets; without it, they show as problems. */
	loadFunctions?: LoadFunctions;
}

/** The admin route: plugin pages and the dashboard widget. */
export async function serveAdmin({ ctx, viewer, store, surface, authoring, loadFunctions }: ServeOptions, interaction: Interaction, where: 'admin-page' | 'dashboard-widget'): Promise<Response> {
	const served = await servable(store, surface);
	let toast: Response['toast'];
	let states: WidgetStates = {};

	if (where === 'dashboard-widget') {
		const instances = served.filter((s) => s.build.mount.slot === 'dashboard.widget' && inAudience(s, viewer)).map((s) => ({ served: s, slot: {} }));
		if (interaction.type === 'block_action' && interaction.action_id) {
			({ toast, states } = await act(ctx, viewer, instances, surface, loadFunctions, interaction.action_id, interaction.value));
		}
		const { blocks } = await renderAll(ctx, viewer, instances, surface, loadFunctions, true, states);
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
		({ toast, states } = await act(ctx, viewer, instances, surface, loadFunctions, interaction.action_id, interaction.value));
		open = Math.max(0, instances.findIndex((i) => i.served.record.id === interaction.action_id!.split(':')[0]));
	}
	const panels: Array<{ label: string; blocks: Block[] }> = [];
	for (const instance of instances) {
		const { blocks } = await renderAll(ctx, viewer, [instance], surface, loadFunctions, false, states);
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
	{ ctx, viewer, store, surface, loadFunctions }: ServeOptions,
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
	let states: WidgetStates = {};
	if (interaction.type === 'block_action' && interaction.action_id) {
		({ toast, states } = await act(ctx, viewer, instances, surface, loadFunctions, interaction.action_id, interaction.value));
		if (toast?.type === 'success') {
			const fresh = await runCapability(ctx, viewer, 'content.get', { collection: entry.collection, id: entry.id });
			instances.forEach((i) => (i.slot = { entry: fresh }));
		}
	}
	const { blocks } = await renderAll(ctx, viewer, instances, surface, loadFunctions, served.length > 1, states);
	return withToast({ blocks }, toast);
}

function withToast(response: Response, toast: Response['toast']): Response {
	return toast ? { ...response, toast } : response;
}
