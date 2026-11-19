import type { Capability } from '@swissspidy/graft-core';
import type { Perform } from '../host/gateway.ts';
import { CallError, checkOutput } from '../host/http.ts';
import { tabsBinding } from './surface.ts';

/**
 * The browser surface's capabilities, over a small tab API: Chrome's in
 * the extension (../extension/tabs.ts), an in-memory browser in the
 * verification sandbox (../node/chrome-sandbox.ts). The same functions
 * run in both, so a check proves the filtering, ordering and answers the
 * extension will give. Answers are cut down to the declared output and
 * checked against it, as an app's are.
 */

/** A tab, as the API reports it. */
export interface Tab {
	id: number;
	title: string;
	url: string;
	pinned: boolean;
	active: boolean;
	/** When it was last active, in ms since the epoch. */
	lastAccessed?: number;
}

export interface Tabs {
	query(): Promise<Tab[]>;
	get(id: number): Promise<Tab | undefined>;
	remove(id: number): Promise<void>;
	/** Opens a tab in the background. */
	create(url: string): Promise<Tab>;
	focus(id: number): Promise<Tab>;
}

const DAY = 24 * 60 * 60 * 1000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A tab as capabilities answer with it. */
export function tabJson(tab: Tab): Record<string, unknown> {
	return {
		id: tab.id,
		title: tab.title,
		url: tab.url,
		pinned: tab.pinned,
		active: tab.active,
		lastUsed: typeof tab.lastAccessed === 'number' && Number.isFinite(tab.lastAccessed) ? new Date(tab.lastAccessed).toISOString() : null,
	};
}

/** The tabs `tabs.list` answers with for an input, at a time. */
export function listTabs(tabs: Tab[], input: Record<string, unknown>, now: number): Tab[] {
	const days = typeof input.unusedForDays === 'number' ? input.unusedForDays : undefined;
	return tabs
		.filter((tab) => typeof input.pinned !== 'boolean' || tab.pinned === input.pinned)
		.filter((tab) => days === undefined || (typeof tab.lastAccessed === 'number' && now - tab.lastAccessed > days * DAY))
		.sort((a, b) => (a.lastAccessed ?? 0) - (b.lastAccessed ?? 0) || a.id - b.id);
}

async function existing(tabs: Tabs, id: unknown): Promise<Tab> {
	const tab = typeof id === 'number' ? await tabs.get(id) : undefined;
	if (!tab) {
		throw new CallError('host_not_found', 'That tab is not open any more.');
	}
	return tab;
}

async function run(tabs: Tabs, capability: Capability, input: Record<string, unknown>, now: number): Promise<unknown> {
	const { api } = tabsBinding(capability);
	switch (api) {
		case 'tabs.list':
			return { tabs: listTabs(await tabs.query(), input, now).map(tabJson) };
		case 'tabs.close': {
			const tab = await existing(tabs, input.id);
			await tabs.remove(tab.id);
			return tabJson(tab);
		}
		case 'tabs.open': {
			const url = typeof input.url === 'string' ? input.url : '';
			// The schema says so too; this is the one place a page address leaves the extension, so it is checked twice.
			if (!/^https?:\/\//.test(url)) {
				throw new CallError('graft_invalid_input', 'Only web pages (http or https) can be opened.');
			}
			return tabJson(await tabs.create(url));
		}
		case 'tabs.focus':
			return tabJson(await tabs.focus((await existing(tabs, input.id)).id));
		default:
			throw new CallError('graft_invalid_binding', `Unknown tab function "${String(api)}".`);
	}
}

/** Capability calls as tab functions. `now` is the clock `unusedForDays` counts to (a trigger run's, say). */
export function tabsPerform(tabs: Tabs, now: () => number = Date.now): Perform {
	return async (_name, capability, input) => {
		let body: unknown;
		try {
			body = await run(tabs, capability, isObject(input) ? input : {}, now());
		} catch (error) {
			throw error instanceof CallError ? error : new CallError('host_error', `The browser refused: ${(error as Error).message}`);
		}
		const { output, problems } = checkOutput(capability, body);
		if (problems.length > 0) {
			throw new CallError('graft_drift', `The browser's answer does not match the surface (${problems.slice(0, 3).join('; ')}).`, problems);
		}
		return output;
	};
}
