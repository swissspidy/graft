import {
	compileSchema,
	evaluate,
	extractRefs,
	hashSpec,
	validateBuild,
	validateSpec,
	type Build,
	type CustomizationBundle,
	type SpecManifest,
	type Surface,
	type Verification,
} from '@swissspidy/graft-core';
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
 * The request goes to the page's own origin, at the binding's path, with
 * the viewer's session; its answer is cut down to the declared output.
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
		if (!verification.passed || verification.spec.hash !== specHash || verification.surface.hash !== surface.hash) {
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
	const { build, verification } = installed;
	if (build.surface.hash !== surface.hash) {
		return 'Its build is for another version of the app.';
	}
	if (build.spec.hash !== installed.specHash || (await hashSpec(installed.source)) !== installed.specHash) {
		return 'Its build is for another version of its spec.';
	}
	if (!verification.passed || verification.surface.hash !== surface.hash || verification.spec.hash !== installed.specHash) {
		return 'Its build has not passed its checks for this version of the app.';
	}
	const missing = extractRefs(build, surface).scopes.filter((scope) => !installed.grant!.includes(scope));
	if (missing.length > 0) {
		return `It needs permissions that were not approved: ${missing.join(', ')}.`;
	}
	return undefined;
}

/** A customization mounted on a page: where, and the slot props from the URL. */
export interface Mount {
	installed: Installed;
	slot: string;
	anchor: Anchor;
	props: Record<string, unknown>;
}

/** The servable customizations whose slots are on this page. */
export async function mountsFor(list: Installed[], surface: Surface, url: string): Promise<Mount[]> {
	const model = appModel(surface);
	if (!model.app.origins.some((origin) => originMatches(origin, url))) {
		return [];
	}
	const mounts: Mount[] = [];
	for (const installed of list) {
		const slot = installed.build.mount.slot;
		const anchor = model.anchors[slot];
		const props = anchor ? slotProps(anchor, url) : undefined;
		if (anchor && props && (await unservable(installed, surface)) === undefined) {
			mounts.push({ installed, slot, anchor, props });
		}
	}
	return mounts;
}

export type Call = (capability: string, input: unknown) => Promise<unknown>;

/** The gateway for one customization on one page. */
export function gatewayCall(installed: Installed, surface: Surface, origin: string, fetch: Fetch, onDrift?: (capability: string, details: string[]) => void): Call {
	const used = new Set(extractRefs(installed.build, surface).capabilities);
	const grant = installed.grant ?? [];
	return async (capability, input) => {
		const declared = surface.capabilities[capability];
		if (!declared || !used.has(capability)) {
			throw new CallError('graft_capability_not_in_build', `This customization does not use "${capability}".`);
		}
		if (!declared.scopes.every((scope) => grant.includes(scope))) {
			throw new CallError('graft_not_granted', `"${capability}" needs a permission that was not approved.`);
		}
		const value = input ?? {};
		if (!compileSchema(declared.input as object)(value)) {
			throw new CallError('graft_invalid_input', `Invalid input for "${capability}".`);
		}
		try {
			return await perform(declared, value, origin, fetch);
		} catch (error) {
			if (error instanceof CallError && error.code === 'graft_drift') {
				onDrift?.(capability, error.details ?? [error.message]);
			}
			throw error;
		}
	};
}

export interface PageContext {
	surface: Surface;
	/** The page's URL, as the browser reports the sender's (never as the page claims). */
	url: string;
	fetch: Fetch;
	onDrift?: (capability: string, details: string[]) => void;
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
export async function renderMount(page: PageContext, mount: Mount, state: Record<string, unknown> = {}, role?: string): Promise<MountRender> {
	const { installed } = mount;
	const viewer = role ?? (await pageRole(page));
	const audience = installed.manifest.audience ?? [];
	const call = gatewayCall(installed, page.surface, new URL(page.url).origin, page.fetch, page.onDrift);
	if (audience.length > 0 && (viewer === undefined || !audience.includes(viewer))) {
		return { view: [], actions: [], problems: [], call, state };
	}
	const can = createCan(usableScopes(page.surface, viewer, installed.grant ?? []));
	const now = Date.now();
	const data: Record<string, unknown> = {};
	const errors: string[] = [];
	for (const [name, source] of Object.entries(installed.build.data)) {
		try {
			data[name] = await call(source.call, evaluate(source.input, { data: {}, slot: mount.props, can, now }) ?? null);
		} catch (error) {
			errors.push(errorMessage(error));
		}
	}
	const rendered = renderA2UI(installed.build, { data, slot: mount.props, can, now }, installed.id, state);
	const notices: ViewNode[] = [];
	if (errors.length > 0) {
		notices.push({ type: 'notice', tone: 'error', text: `Some data could not be loaded. ${errors.join(' ')}` });
	}
	if (rendered.problems.length > 0) {
		notices.push({ type: 'notice', tone: 'error', text: `Some of this could not be drawn. ${rendered.problems.join(' ')}` });
	}
	return { ...rendered, view: [...notices, ...rendered.view], call, state };
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
export async function act(page: PageContext, mount: Mount, key: string, state: Record<string, unknown> = {}): Promise<ActResult> {
	const role = await pageRole(page);
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
