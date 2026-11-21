import { hashSurface, type Capability, type JsonSchema, type Scope, type Slot, type Surface, type SurfaceTriggers } from '@swissspidy/graft-core';
import { undoProblems, type Undo } from '../host/undo.ts';

/**
 * The browser itself as a Graft host (`host: chrome`): customizations of
 * the person's browser rather than of an app in it. Where an app surface
 * (../host/surface.ts) is described from the outside and kept honest by
 * probing, this one is the extension's own code: the capabilities are
 * functions over `chrome.tabs` (./tabs.ts), the one slot is the
 * extension's side panel, and its scopes map to the Chrome permissions the
 * manifest asks for. It changes only when the extension does, so it is
 * generated like the WordPress surface, not observed.
 *
 * There are no audiences: a browser profile has one person. Triggers run
 * as that person's extension, with the grant approved for each trigger.
 */

export const CHROME = 'chrome';

/** Which tab function a capability runs. */
export interface TabsBinding {
	api: 'tabs.list' | 'tabs.close' | 'tabs.open' | 'tabs.focus';
	undo?: Undo;
}

/** The host-defined part of the browser surface (`surface.model`). */
export interface BrowserModel {
	/** Chrome permissions each scope needs; the manifest asks for them. */
	permissions: Record<string, string[]>;
	/** The extension page each owned slot is drawn in. */
	pages: Record<string, string>;
}

const tab: JsonSchema = {
	type: 'object',
	properties: {
		id: { type: 'integer' },
		title: { type: 'string' },
		url: { type: 'string' },
		pinned: { type: 'boolean' },
		active: { description: 'Whether it is the tab shown in its window.', type: 'boolean' },
		lastUsed: { description: 'When the person last had it in front of them (ISO 8601), or null when Chrome does not know.', type: ['string', 'null'] },
	},
	required: ['id', 'title', 'url', 'pinned', 'active', 'lastUsed'],
	additionalProperties: false,
};

const tabId = { type: 'object', properties: { id: { type: 'integer', minimum: 0 } }, required: ['id'], additionalProperties: false } as const;

const capabilities: Record<string, Capability & { binding: TabsBinding }> = {
	'tabs.list': {
		kind: 'read',
		description: 'The open tabs of every window, least recently used first; optionally only pinned or unpinned ones, or only those not used for more than a number of days.',
		input: {
			type: 'object',
			properties: {
				pinned: { type: 'boolean' },
				unusedForDays: { description: 'Only tabs last used more than this many days ago; a tab in front of its window is in use.', type: 'integer', minimum: 1, maximum: 365 },
			},
			additionalProperties: false,
		},
		output: { type: 'object', properties: { tabs: { type: 'array', items: tab } }, required: ['tabs'], additionalProperties: false },
		scopes: ['tabs:read'],
		binding: { api: 'tabs.list' },
	},
	'tabs.close': {
		kind: 'write',
		description: 'Closes a tab. Answers with the tab as it was, so it can be opened again.',
		input: tabId,
		output: tab,
		scopes: ['tabs:write'],
		binding: { api: 'tabs.close', undo: { capability: 'tabs.open', input: { url: { output: '/url' } } } },
	},
	'tabs.open': {
		kind: 'write',
		description: 'Opens a web page (http or https) in a new tab, in the background.',
		input: {
			type: 'object',
			properties: { url: { type: 'string', pattern: '^https?://', maxLength: 2048 } },
			required: ['url'],
			additionalProperties: false,
		},
		output: tab,
		scopes: ['tabs:write'],
		binding: { api: 'tabs.open' },
	},
	'tabs.focus': {
		kind: 'write',
		description: 'Brings a tab to the front of its window.',
		input: tabId,
		output: tab,
		scopes: ['tabs:write'],
		binding: { api: 'tabs.focus' },
	},
};

const scopes: Record<string, Scope> = {
	'tabs:read': { title: 'See the titles and addresses of your open tabs' },
	'tabs:write': { title: 'Open, close and switch between your tabs' },
};

const slots: Record<string, Slot> = {
	'side-panel': {
		kind: 'owned',
		title: 'Side panel',
		description: "The extension's side panel, which the person opens from the toolbar next to any page.",
		anchor: 'side panel',
		options: {
			type: 'object',
			properties: { title: { type: 'string', minLength: 1, maxLength: 60 } },
			required: ['title'],
			additionalProperties: false,
		},
		provides: { type: 'object', properties: {}, additionalProperties: false },
	},
};

const triggers: SurfaceTriggers = {
	identity: 'the extension in your browser, with only the permissions approved for each trigger',
	minInterval: 3600,
	maxPerRun: 20,
	capabilities: ['tabs.list', 'tabs.close'],
	events: {},
};

const model: BrowserModel = {
	permissions: { 'tabs:read': ['tabs'], 'tabs:write': [] },
	pages: { 'side-panel': 'sidepanel.html' },
};

/** The oldest Chrome whose APIs this surface describes (`chrome.sidePanel`, `tab.lastAccessed`). */
export const MINIMUM_CHROME = '121';

/** The browser surface, hashed. */
export async function chromeSurface(): Promise<Surface> {
	const problems = undoProblems(capabilities);
	if (problems.length > 0) {
		throw new Error(`The browser surface is invalid: ${problems.join(' ')}`);
	}
	const surface: Surface = {
		graft: 1,
		host: CHROME,
		hostVersion: MINIMUM_CHROME,
		slots,
		capabilities,
		scopes,
		model: model as unknown as Record<string, unknown>,
		triggers,
	};
	return { ...surface, hash: await hashSurface(surface) };
}

/** The model of the browser surface. */
export function browserModel(surface: Surface): BrowserModel {
	const found = surface.model as unknown as BrowserModel | undefined;
	if (surface.host !== CHROME || !found?.permissions || !found.pages) {
		throw new Error(`Not a browser surface: ${surface.host}.`);
	}
	return found;
}

/** The tab function of a capability. */
export function tabsBinding(capability: Capability): TabsBinding {
	const binding = capability.binding as Partial<TabsBinding> | undefined;
	if (!binding || typeof binding.api !== 'string') {
		throw new Error('The capability has no tab binding.');
	}
	return binding as TabsBinding;
}
