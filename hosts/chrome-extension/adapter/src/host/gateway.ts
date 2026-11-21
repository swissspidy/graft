import {
	compileSchema,
	evaluate,
	extractRefs,
	hashSpec,
	validateBuild,
	validateSpec,
	verificationProblem,
	type Build,
	type CustomizationBundle,
	type SpecManifest,
	type Surface,
	type Verification,
} from '@swissspidy/graft-core';
import type { Capability } from '@swissspidy/graft-core';
import { nextState, renderA2UI, type Rendered, type ViewNode } from './a2ui.ts';
import { createCan, usableScopes } from './can.ts';
import { CallError, perform, viewerRole, type Fetch } from './http.ts';
import { originMatches, slotProps } from './pages.ts';
import { appModel, type Anchor } from './surface.ts';

/**
 * The capability gateway of the browser host. It runs in the extension's
 * service worker, never in the page: content scripts ask it what to draw
 * where, and send back the key of a button that was clicked. Everything
 * else (which customizations apply, their data, what a button does) is
 * decided here, from the stored customization and a fresh render.
 *
 * A call goes out only if:
 * - the page is on one of the app's origins, and the customization's slot
 *   is on this page;
 * - the customization is approved, its build verified for this spec
 *   version and this surface, and its grant covers the build's scopes;
 * - the build uses the capability (computed from its content, not its
 *   stored refs) and the grant covers the capability's scopes;
 * - the input matches the capability's schema.
 * On an app's page, the request goes to the page's own origin, at the
 * binding's path, with the viewer's session; its answer is cut down to the
 * declared output. On the browser's own surface (../browser) the call is
 * one of the extension's tab functions instead. Either way the gateway
 * reports every call it refuses or makes (`onCall`), which is what the
 * extension's activity log and undo are built from.
 */

/** A customization as the extension stores it. */
export interface Installed {
	id: string;
	title: string;
	source: string;
	manifest: SpecManifest;
	specHash: string;
	build: Build;
	verification: Verification;
	/** Approved scopes; null until someone approves them. */
	grant: string[] | null;
	/** The scopes approved for each trigger, apart from the viewer's (ADR 0010); set with `grant`. */
	triggerGrants?: Record<string, string[]>;
	approvedAt?: string;
	/** Where it came from: a bundle shipped with the extension, a Graft server, … */
	from: string;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A customization from a bundle, for this surface: the bundle's build for
 * the surface's hash, validated against the surface and the spec, with a
 * passing verification for both. Returns the problems instead when there
 * is none.
 */
export async function fromBundle(bundle: CustomizationBundle, surface: Surface, from: string): Promise<{ installed?: Installed; problems: string[] }> {
	const problems: string[] = [];
	if (bundle.graft !== 1 || bundle.kind !== 'customization') {
		return { problems: ['Not a customization bundle.'] };
	}
	const specHash = await hashSpec(bundle.spec.source);
	const { spec } = validateSpec(bundle.spec.source, { surface });
	if (!spec || specHash !== bundle.spec.hash) {
		return { problems: [spec ? 'The bundle’s spec hash does not match its source.' : 'The bundle’s spec does not validate against this app.'] };
	}
	for (const { build, verification } of bundle.builds) {
		if (build.surface.hash !== surface.hash) {
			continue;
		}
		const validation = await validateBuild(build, surface, { spec: { spec, hash: specHash } });
		const errors = validation.diagnostics.filter((d) => d.severity === 'error');
		if (errors.length > 0) {
			problems.push(...errors.map((d) => `${d.path ?? ''} ${d.message}`.trim()));
			continue;
		}
		// The record must name this build: a build edited after it was verified is not verified.
		if (build.spec.hash !== specHash || build.surface.hash !== surface.hash || (await verificationProblem(verification, build))) {
			problems.push('Its build was not verified for this spec and this version of the app.');
			continue;
		}
		return {
			installed: { id: spec.manifest.id, title: bundle.title, source: bundle.spec.source, manifest: spec.manifest, specHash, build, verification, grant: null, from },
			problems: [],
		};
	}
	return { problems: problems.length > 0 ? problems : ['The bundle has no build for this version of the app.'] };
}

/** Why a stored customization may not be served on this surface, or undefined when it may. */
export async function unservable(installed: Installed, surface: Surface): Promise<string | undefined> {
	if (!installed.grant) {
		return 'It is waiting for approval.';
	}
	const unchecked = await unverified(installed, surface);
	if (unchecked) {
		return unchecked;
	}
	const missing = extractRefs(installed.build, surface).scopes.filter((scope) => !installed.grant!.includes(scope));
	if (missing.length > 0) {
		return `It needs permissions that were not approved: ${missing.join(', ')}.`;
	}
	return undefined;
}

/**
 * Why a stored customization's build is not the verified build for this
 * surface and spec, or undefined when it is. What serving needs apart from
 * the grant; all a preview needs.
 */
export async function unverified(installed: Installed, surface: Surface): Promise<string | undefined> {
	const { build, verification } = installed;
	if (build.surface.hash !== surface.hash) {
		return 'Its build is for another version of the app.';
	}
	if (build.spec.hash !== installed.specHash || (await hashSpec(installed.source)) !== installed.specHash) {
		return 'Its build is for another version of its spec.';
	}
	if (verification.surface?.hash !== surface.hash || (await verificationProblem(verification, build))) {
		return 'Its build has not passed its checks for this version of the app.';
	}
	return undefined;
}

/**
 * What a preview may use: the scopes of the read capabilities the build
 * uses, of those its spec asks for. A preview reads with the person's
 * account after they asked for it, and never writes.
 */
export function previewGrant(installed: Installed, surface: Surface): string[] {
	const reads = extractRefs(installed.build, surface).capabilities.filter((name) => surface.capabilities[name]?.kind === 'read');
	const scopes = new Set(reads.flatMap((name) => surface.capabilities[name]!.scopes));
	return installed.manifest.permissions.filter((scope) => scopes.has(scope));
}

/** The customization as a preview draws it: unapproved, with only the preview's grant. */
export function asPreview(installed: Installed, surface: Surface): Installed {
	const { triggerGrants: _triggerGrants, ...rest } = installed;
	return { ...rest, grant: previewGrant(installed, surface) };
}

/** A customization mounted on a page: where, and the slot props from the URL. */
export interface Mount {
	installed: Installed;
	slot: string;
	/** Where it goes in an app's page; none for a place the extension owns (the side panel). */
	anchor?: Anchor;
	props: Record<string, unknown>;
	/** A preview the person asked for before approving it: read-only, and drawn without its buttons that act. */
	preview?: boolean;
}

/**
 * The servable customizations whose slots are on this page, and the
 * previews asked for (by id) of those that are not approved but verified.
 */
export async function mountsFor(list: Installed[], surface: Surface, url: string, previews: ReadonlySet<string> = new Set()): Promise<Mount[]> {
	const model = appModel(surface);
	if (!model.app.origins.some((origin) => originMatches(origin, url))) {
		return [];
	}
	const mounts: Mount[] = [];
	for (const installed of list) {
		const slot = installed.build.mount.slot;
		const anchor = model.anchors[slot];
		const props = anchor ? slotProps(anchor, url) : undefined;
		if (!anchor || !props) {
			continue;
		}
		if ((await unservable(installed, surface)) === undefined) {
			mounts.push({ installed, slot, anchor, props });
		} else if (!installed.grant && previews.has(installed.id) && (await unverified(installed, surface)) === undefined) {
			mounts.push({ installed: asPreview(installed, surface), slot, anchor, props, preview: true });
		}
	}
	return mounts;
}

export type Call = (capability: string, input: unknown) => Promise<unknown>;

/** Runs a capability the gateway let through: a request to the app, or a tab function. Rejects with a CallError. */
export type Perform = (name: string, capability: Capability, input: unknown) => Promise<unknown>;

/** Capability calls as requests to the app on `origin`, with the session `fetch` carries. */
export function httpPerform(origin: string, fetch: Fetch): Perform {
	return (_name, capability, input) => perform(capability, input, origin, fetch);
}

/** A call the gateway refused or made, as it reports it. */
export interface CallRecord {
	capability: string;
	kind: 'read' | 'write';
	input: unknown;
	/** ok: it went through; refused: the gateway stopped it; failed: the host refused or broke. */
	outcome: 'ok' | 'refused' | 'failed';
	code?: string;
	error?: string;
	/** The projected answer, when it went through. */
	output?: unknown;
}

export interface GatewayHooks {
	onDrift?: (capability: string, details: string[]) => void;
	onCall?: (record: CallRecord) => void;
}

const REFUSALS = new Set(['graft_capability_not_in_build', 'graft_not_granted', 'graft_invalid_input', 'graft_invalid_binding', 'graft_capability_not_in_trigger', 'graft_capability_not_unattended']);

/**
 * Runs `perform` behind checks and reports the outcome: what refusal or
 * host error it ended in, or its answer. `refusal` is the gateway's own
 * check, before anything reaches the host.
 */
export async function guarded(
	name: string,
	declared: Capability | undefined,
	input: unknown,
	refusal: CallError | undefined,
	run: Perform,
	hooks: GatewayHooks = {},
): Promise<unknown> {
	const kind = declared?.kind ?? 'read';
	if (refusal || !declared) {
		const error = refusal ?? new CallError('graft_capability_not_in_build', `This customization does not use "${name}".`);
		hooks.onCall?.({ capability: name, kind, input, outcome: 'refused', code: error.code, error: error.message });
		throw error;
	}
	try {
		const output = await run(name, declared, input);
		hooks.onCall?.({ capability: name, kind, input, outcome: 'ok', output });
		return output;
	} catch (error) {
		const code = error instanceof CallError ? error.code : 'host_error';
		if (error instanceof CallError && error.code === 'graft_drift') {
			hooks.onDrift?.(name, error.details ?? [error.message]);
		}
		hooks.onCall?.({ capability: name, kind, input, outcome: REFUSALS.has(code) ? 'refused' : 'failed', code, error: errorMessage(error) });
		throw error;
	}
}

/** The gateway for one customization on one page; read-only for a preview. */
export function gatewayCall(installed: Installed, surface: Surface, run: Perform, hooks: GatewayHooks = {}, options: { readOnly?: boolean } = {}): Call {
	const used = new Set(extractRefs(installed.build, surface).capabilities);
	const grant = installed.grant ?? [];
	return async (capability, input) => {
		const declared = surface.capabilities[capability];
		const value = input ?? {};
		let refusal: CallError | undefined;
		if (!declared || !used.has(capability)) {
			refusal = new CallError('graft_capability_not_in_build', `This customization does not use "${capability}".`);
		} else if (options.readOnly && declared.kind !== 'read') {
			refusal = new CallError('graft_preview_read_only', 'This is a preview: nothing changes until you approve it.');
		} else if (!declared.scopes.every((scope) => grant.includes(scope))) {
			refusal = new CallError('graft_not_granted', `"${capability}" needs a permission that was not approved.`);
		} else if (!compileSchema(declared.input as object)(value)) {
			refusal = new CallError('graft_invalid_input', `Invalid input for "${capability}".`);
		}
		return guarded(capability, declared, value, refusal, run, hooks);
	};
}

/** Where a customization is drawn: the surface, how its calls run, and who is looking. */
export interface Context extends GatewayHooks {
	surface: Surface;
	perform: Perform;
	/** The viewer's audience (an app role), if the surface has audiences. */
	role(): Promise<string | undefined>;
	/** The render's clock, in ms since the epoch. Default: now. */
	now?: number;
}

/** An app's page. */
export interface PageContext extends GatewayHooks {
	surface: Surface;
	/** The page's URL, as the browser reports the sender's (never as the page claims). */
	url: string;
	fetch: Fetch;
}

/** The context of an app's page: calls to the page's origin, and the viewer's role from the app. */
export function pageContext(page: PageContext | Context): Context {
	if ('perform' in page) {
		return page;
	}
	return {
		surface: page.surface,
		perform: httpPerform(new URL(page.url).origin, page.fetch),
		role: () => pageRole(page),
		...(page.onDrift ? { onDrift: page.onDrift } : {}),
		...(page.onCall ? { onCall: page.onCall } : {}),
	};
}

export interface MountRender extends Rendered {
	call: Call;
	state: Record<string, unknown>;
}

/** The viewer's app role on a page (read once per render). */
export async function pageRole(page: PageContext): Promise<string | undefined> {
	try {
		return await viewerRole(appModel(page.surface).viewer, new URL(page.url).origin, page.fetch);
	} catch {
		return undefined;
	}
}

/** Renders one mounted customization for the viewer, loading its data through the gateway. */
export async function renderMount(where: PageContext | Context, mount: Mount, state: Record<string, unknown> = {}, role?: string): Promise<MountRender> {
	const ctx = pageContext(where);
	const { installed } = mount;
	const viewer = role ?? (await ctx.role());
	const audience = installed.manifest.audience ?? [];
	const call = gatewayCall(installed, ctx.surface, ctx.perform, ctx, { readOnly: mount.preview === true });
	if (audience.length > 0 && (viewer === undefined || !audience.includes(viewer))) {
		return { view: [], actions: [], problems: [], call, state };
	}
	const can = createCan(usableScopes(ctx.surface, viewer, installed.grant ?? []));
	const now = ctx.now ?? Date.now();
	const data: Record<string, unknown> = {};
	const errors: string[] = [];
	for (const [name, source] of Object.entries(installed.build.data)) {
		try {
			data[name] = await call(source.call, evaluate(source.input, { data: {}, slot: mount.props, can, now }) ?? null);
		} catch (error) {
			errors.push(errorMessage(error));
		}
	}
	const drawn = renderA2UI(installed.build, { data, slot: mount.props, can, now }, installed.id, state);
	const rendered = mount.preview ? withoutWrites(drawn) : drawn;
	const notices: ViewNode[] = [];
	if (mount.preview) {
		notices.push({ type: 'notice', tone: 'info', text: 'Preview with your data: it reads, and changes nothing until you approve it on the options page.' });
	}
	if (errors.length > 0) {
		notices.push({ type: 'notice', tone: 'error', text: `Some data could not be loaded. ${errors.join(' ')}` });
	}
	if (rendered.problems.length > 0) {
		notices.push({ type: 'notice', tone: 'error', text: `Some of this could not be drawn. ${rendered.problems.join(' ')}` });
	}
	return { ...rendered, view: [...notices, ...rendered.view], call, state };
}

/** A render with every button that would call a capability taken out; local ones (filters, tabs) stay. */
export function withoutWrites(rendered: Rendered): Rendered {
	const gone = new Set(rendered.actions.filter((a) => a.action).map((a) => a.key));
	const strip = (nodes: ViewNode[]): ViewNode[] =>
		nodes.flatMap((node): ViewNode[] => {
			if (node.type === 'button') {
				return gone.has(node.button.key) ? [] : [node];
			}
			if (node.type === 'group') {
				return [{ ...node, children: strip(node.children) }];
			}
			if (node.type === 'table') {
				return [{ ...node, rows: node.rows.map((row) => ({ ...row, buttons: row.buttons.filter((b) => !gone.has(b.key)) })) }];
			}
			return [node];
		});
	return { ...rendered, view: strip(rendered.view), actions: rendered.actions.map((a) => (a.action ? { ...a, available: false } : a)) };
}

export interface ActResult {
	view: ViewNode[];
	state: Record<string, unknown>;
	notice?: { tone: 'success' | 'error'; text: string };
}

/**
 * A click on a button: finds its key in a fresh render (with the state the
 * content script sent back) and runs what it does through the gateway, or
 * computes the next state for a local action. Then renders again.
 */
export async function act(where: PageContext | Context, mount: Mount, key: string, state: Record<string, unknown> = {}): Promise<ActResult> {
	const page = pageContext(where);
	const role = await page.role();
	const before = await renderMount(page, mount, state, role);
	const found = before.actions.find((a) => a.available && a.key === key);
	if (!found) {
		return { view: before.view, state, notice: { tone: 'error', text: 'That action is not available.' } };
	}
	if (found.set) {
		const next = nextState(state, found.set);
		return { view: (await renderMount(page, mount, next, role)).view, state: next };
	}
	const action = found.action!;
	try {
		await before.call(action.capability, action.input ?? null);
	} catch (error) {
		return { view: before.view, state, notice: { tone: 'error', text: errorMessage(error) } };
	}
	// The data is loaded again whatever `then` says: nothing here keeps a view to update in place.
	return { view: (await renderMount(page, mount, state, role)).view, state, notice: { tone: 'success', text: action.notice ?? 'Done.' } };
}
