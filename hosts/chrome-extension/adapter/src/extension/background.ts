import { describeCheck, setSchemaEngine, validateSpec, type CustomizationBundle, type Surface } from '@swissspidy/graft-core';
import { cfworkerEngine } from '@swissspidy/graft-core/cfworker';
import { describers } from '../host/describe.ts';
import { act, fromBundle, mountsFor, renderMount, unservable, type Installed, type Mount, type PageContext } from '../host/gateway.ts';
import { originMatches } from '../host/pages.ts';
import { appModel } from '../host/surface.ts';
import type { ContentMessage, DriftEvent, Listed, MountInfo, OptionsMessage, Reply } from './messages.ts';
import '../host/a2ui.ts';

/**
 * The service worker: the extension's gateway and store. It holds the
 * app surfaces and customizations the extension ships with, which the
 * options page approves, and answers the content scripts. Nothing here
 * listens to web pages: the manifest has no externally_connectable and no
 * web-accessible resources, so only the extension's own content scripts
 * and pages reach it.
 *
 * Manifest V3 forbids generated code, so schemas are validated with the
 * cfworker engine instead of Ajv.
 */

setSchemaEngine(cfworkerEngine());

const PACKAGED = 'packaged';

interface Packaged {
	surfaces: Surface[];
	bundles: CustomizationBundle[];
}

let packaged: Promise<Packaged> | undefined;

/** The surfaces and bundles shipped in the extension package (written by scripts/build-extension.ts). */
function loadPackaged(): Promise<Packaged> {
	packaged ??= (async () => {
		const read = async <T>(file: string) => (await (await fetch(chrome.runtime.getURL(file))).json()) as T;
		return { surfaces: await read<Surface[]>('graft/surfaces.json'), bundles: await read<CustomizationBundle[]>('graft/customizations.json') };
	})();
	return packaged;
}

async function stored(): Promise<Record<string, Installed>> {
	return ((await chrome.storage.local.get('customizations')).customizations as Record<string, Installed> | undefined) ?? {};
}

async function store(customizations: Record<string, Installed>): Promise<void> {
	await chrome.storage.local.set({ customizations });
}

/**
 * Installs the packaged bundles that validate for a shipped surface. A
 * customization keeps its grant while its spec version is the same;
 * a new spec version waits for approval again.
 */
async function installPackaged(): Promise<void> {
	const { surfaces, bundles } = await loadPackaged();
	const customizations = await stored();
	for (const bundle of bundles) {
		for (const surface of surfaces) {
			const { installed, problems } = await fromBundle(bundle, surface, PACKAGED);
			if (!installed) {
				if (bundle.builds.some((b) => b.build.surface.hash === surface.hash)) {
					console.warn(`Graft: not installing "${bundle.title}":`, problems.join(' '));
				}
				continue;
			}
			const previous = customizations[installed.id];
			const keep = previous && previous.specHash === installed.specHash && previous.grant;
			customizations[installed.id] = keep ? { ...installed, grant: previous.grant, ...(previous.approvedAt ? { approvedAt: previous.approvedAt } : {}) } : installed;
		}
	}
	await store(customizations);
}

let ready: Promise<void> | undefined;
const whenReady = () => (ready ??= installPackaged());

chrome.runtime.onInstalled.addListener(() => {
	ready = installPackaged();
});

async function surfaceFor(url: string): Promise<Surface | undefined> {
	const { surfaces } = await loadPackaged();
	return surfaces.find((surface) => appModel(surface).app.origins.some((origin) => originMatches(origin, url)));
}

async function recordDrift(event: Omit<DriftEvent, 'at'>): Promise<void> {
	const drift = ((await chrome.storage.local.get('drift')).drift as DriftEvent[] | undefined) ?? [];
	drift.push({ at: new Date().toISOString(), ...event });
	await chrome.storage.local.set({ drift: drift.slice(-50) });
}

async function pageFor(url: string): Promise<{ page: PageContext; mounts: Mount[] } | undefined> {
	const surface = await surfaceFor(url);
	if (!surface) {
		return undefined;
	}
	const page: PageContext = {
		surface,
		url,
		fetch: (input, init) => fetch(input, init),
		onDrift: (capability, details) => void recordDrift({ kind: 'capability', symbol: capability, url, details }),
	};
	return { page, mounts: await mountsFor(Object.values(await stored()), surface, url) };
}

const CONTENT_MESSAGES = new Set(['mounts', 'render', 'act', 'anchor']);

async function fromContent(message: ContentMessage, url: string): Promise<unknown> {
	if (!CONTENT_MESSAGES.has(message.type)) {
		throw new Error('Unknown message.');
	}
	const found = await pageFor(url);
	if (!found) {
		return message.type === 'mounts' ? [] : Promise.reject(new Error('This page is not part of an app the extension knows.'));
	}
	const { page, mounts } = found;
	if (message.type === 'mounts') {
		return mounts.map((m): MountInfo => ({ id: m.installed.id, title: (m.installed.build.mount.title as string | undefined) ?? m.installed.title, slot: m.slot, anchor: m.anchor }));
	}
	if (message.type === 'anchor') {
		if (!mounts.some((m) => m.slot === message.slot) || (message.status !== 'moved' && message.status !== 'broken')) {
			throw new Error('No customization is mounted there.');
		}
		await recordDrift({ kind: 'slot', symbol: message.slot, url, details: [message.status, String(message.reason).slice(0, 500)] });
		return null;
	}
	const mount = mounts.find((m) => m.installed.id === message.id);
	if (!mount) {
		throw new Error('That customization is not on this page.');
	}
	const state = typeof message.state === 'object' && message.state !== null && !Array.isArray(message.state) ? message.state : {};
	if (message.type === 'render') {
		const rendered = await renderMount(page, mount, state);
		return { view: rendered.view, state: rendered.state };
	}
	if (message.type === 'act' && typeof message.key === 'string') {
		return act(page, mount, message.key, state);
	}
	throw new Error('Unknown message.');
}

async function fromOptions(message: OptionsMessage): Promise<unknown> {
	const customizations = await stored();
	if (message.type === 'list') {
		const { surfaces } = await loadPackaged();
		const listed: Listed[] = [];
		for (const installed of Object.values(customizations)) {
			const surface = surfaces.find((s) => s.hash === installed.build.surface.hash);
			const blocked = surface ? await unservable(installed, surface) : 'The extension does not know this version of the app.';
			listed.push({
				id: installed.id,
				title: installed.title,
				from: installed.from,
				slot: surface?.slots[installed.build.mount.slot]?.title ?? installed.build.mount.slot,
				permissions: installed.manifest.permissions.map((scope) => ({ scope, title: surface?.scopes[scope]?.title ?? scope })),
				criteria: (validateSpec(installed.source).spec?.criteria ?? []).map((criterion) => ({
					text: criterion.text,
					checks: installed.build.checks.filter((c) => c.criterion === criterion.id).map((c) => describeCheck(c, describers)),
				})),
				approved: installed.grant !== null,
				...(blocked ? { blocked } : {}),
			});
		}
		return listed;
	}
	const installed = customizations[message.id];
	if (!installed) {
		throw new Error('No such customization.');
	}
	if (message.type === 'approve') {
		// The grant is what the spec asks for, as the person read it on the page.
		customizations[message.id] = { ...installed, grant: [...installed.manifest.permissions], approvedAt: new Date().toISOString() };
	} else if (message.type === 'revoke') {
		const { approvedAt: _approvedAt, ...rest } = installed;
		customizations[message.id] = { ...rest, grant: null };
	} else {
		throw new Error('Unknown message.');
	}
	await store(customizations);
	return null;
}

/** Answers a message from the extension's own content scripts and pages; anything else is refused. */
async function handle(message: unknown, sender: chrome.runtime.MessageSender): Promise<Reply<unknown>> {
	try {
		await whenReady();
		if (sender.id !== chrome.runtime.id || typeof message !== 'object' || message === null) {
			throw new Error('Refused.');
		}
		const own = chrome.runtime.getURL('');
		if (sender.url?.startsWith(own) && !sender.frameId) {
			return { ok: true, value: await fromOptions(message as OptionsMessage) };
		}
		// A content script in a top-level page; the URL is the browser's, not something the page says.
		if (!sender.tab || sender.frameId !== 0 || !sender.url) {
			throw new Error('Refused.');
		}
		return { ok: true, value: await fromContent(message as ContentMessage, sender.url) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
	void handle(message, sender).then(reply);
	return true;
});

// For the end-to-end tests and debugging from the service worker's own console; not reachable from pages.
(globalThis as { graft?: unknown }).graft = { handle, stored, store, installPackaged };
