import type { Capability, JsonSchema, Scope, Slot, Surface } from '@swissspidy/graft-core';

/**
 * The browser host: a web app Graft does not control, customized from an
 * extension. The app has no plugin API and no versions, so its surface is
 * described from the outside (an app description, below), and kept honest
 * by fingerprinting what the app actually serves (../node/drift.ts):
 *
 * - a slot is a place in the app's DOM: the pages it is on (URL patterns)
 *   and an anchor (selectors tried in order, and an ARIA landmark that
 *   must match), where the extension inserts its own element;
 * - a capability is a call to the app's own HTTP API with the viewer's
 *   session (an HTTP binding), whose response is cut down to the declared
 *   output before anything sees it;
 * - a scope maps to the app roles that may use it, read from the app's own
 *   "who am I" endpoint.
 *
 * The anchors, the viewer endpoint and the app's origins are the surface's
 * `model`, so they are hashed: moving an anchor is a new surface.
 */

export const HOST = 'browser';

/** A call to the app's API. `{name}` in the path, query and body take input fields of that name. */
export interface HttpBinding {
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	/** Path on the app's origin, e.g. `/api/projects/{project}/tasks`. */
	path: string;
	/** Input fields sent as query parameters, when present. */
	query?: string[];
	/** Input fields sent as a JSON body. */
	body?: string[];
	/** Fixed request headers, e.g. a CSRF header the app wants on writes. */
	headers?: Record<string, string>;
}

/** An ARIA landmark: a role (explicit, or implied by the element) and its accessible name. */
export interface Landmark {
	role: string;
	name?: string;
}

/** Where a slot is in the app's DOM. */
export interface Anchor {
	/** URL path patterns of the pages it is on; `:name` matches one segment and becomes the slot prop `name: { id }`. */
	pages: string[];
	/** CSS selectors, most specific first; the first that matches exactly one element (with the landmark) wins. */
	selectors: string[];
	/** What the element must be; also how re-anchoring finds it again when every selector broke. */
	landmark?: Landmark;
	/** Where the extension's element goes, relative to the anchor. */
	insert: 'append' | 'prepend' | 'before' | 'after';
}

/** The host-defined part of a browser surface (`surface.model`). */
export interface AppModel {
	app: {
		id: string;
		title: string;
		/** Match patterns of the app's origins (also the extension's host permissions), e.g. `https://app.example.com/*`. */
		origins: string[];
	};
	/** The app's "who am I" endpoint and the JSON Pointer of the viewer's role in it. */
	viewer: { binding: HttpBinding; role: string };
	/** Each slot's anchor, by slot id. */
	anchors: Record<string, Anchor>;
}

/** An app as an adapter author describes it; `appSurface` turns it into a Graft surface. */
export interface AppDescription {
	id: string;
	title: string;
	origins: string[];
	/** App roles, lowest first; they are the surface's audiences. */
	roles: string[];
	viewer: AppModel['viewer'];
	slots: Record<string, Slot & { kind: 'extension'; at: Anchor }>;
	capabilities: Record<string, Capability & { binding: HttpBinding }>;
	/** Scopes; `host` lists the app roles that may use each. */
	scopes: Record<string, Scope>;
}

const describeLandmark = (landmark: Landmark | undefined) => (landmark ? `${landmark.role}${landmark.name ? ` "${landmark.name}"` : ''}` : 'element');

/** The surface of an app: the description, with anchors and the viewer endpoint moved into the model. */
export function appSurface(app: AppDescription, observed?: { hostVersion: string; fingerprint: string }): Surface {
	const anchors: Record<string, Anchor> = {};
	const slots: Record<string, Slot> = {};
	for (const [id, { at, ...slot }] of Object.entries(app.slots)) {
		anchors[id] = at;
		slots[id] = { ...slot, anchor: describeLandmark(at.landmark) };
	}
	const model: AppModel = { app: { id: app.id, title: app.title, origins: app.origins }, viewer: app.viewer, anchors };
	return {
		graft: 1,
		host: HOST,
		hostVersion: observed?.hostVersion ?? 'unobserved',
		...(observed ? { fingerprint: observed.fingerprint } : {}),
		slots,
		capabilities: app.capabilities,
		scopes: app.scopes,
		audiences: app.roles,
		model: model as unknown as Record<string, unknown>,
	};
}

/** The app model of a browser surface. */
export function appModel(surface: Surface): AppModel {
	const model = surface.model as unknown as AppModel | undefined;
	if (surface.host !== HOST || !model?.app || !model.anchors || !model.viewer) {
		throw new Error(`Not a browser surface: ${surface.host}.`);
	}
	return model;
}

/** The HTTP binding of a capability. */
export function httpBinding(capability: Capability): HttpBinding {
	const binding = capability.binding as Partial<HttpBinding> | undefined;
	if (!binding || typeof binding.method !== 'string' || typeof binding.path !== 'string' || !binding.path.startsWith('/')) {
		throw new Error('The capability has no HTTP binding.');
	}
	return binding as HttpBinding;
}

/** The JSON Schema of the props a slot on pages with these patterns provides: one `{ id }` per `:param`. */
export function pageProps(pages: string[]): JsonSchema {
	const names = [...new Set(pages.flatMap((page) => [...page.matchAll(/:([a-z][a-z0-9_]*)/g)].map((m) => m[1]!)))].sort();
	return {
		type: 'object',
		properties: Object.fromEntries(
			names.map((name) => [name, { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }]),
		),
		required: names,
		additionalProperties: false,
	};
}
