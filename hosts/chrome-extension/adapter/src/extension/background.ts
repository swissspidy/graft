import { compileSchema, describeCheck, setSchemaEngine, validateSpec, type CustomizationBundle, type Surface } from '@swissspidy/graft-core';
import { cfworkerEngine } from '@swissspidy/graft-core/cfworker';
import { CHROME, browserModel } from '../browser/surface.ts';
import { tabsPerform } from '../browser/tabs.ts';
import { activityFrom, appendActivity, describeActivity, undoRefusal, worthRecording, type Activity, type ActivitySource } from '../host/activity.ts';
import { describers } from '../host/describe.ts';
import { act, fromBundle, guarded, httpPerform, mountsFor, renderMount, unservable, type CallRecord, type Context, type Installed, type Mount, type PageContext } from '../host/gateway.ts';
import { CallError } from '../host/http.ts';
import { originMatches } from '../host/pages.ts';
import { describeTrigger, dueTriggers, nextRun, runInstalledTrigger, stateFor, triggerKey, unrunnable, type TriggerState } from '../host/runner.ts';
import { HOST, appModel } from '../host/surface.ts';
import type { ActivityReply, ContentMessage, DriftEvent, Listed, MountInfo, OptionsMessage, PageMessage, PanelInfo, Reply, RunRecord } from './messages.ts';
import { chromeTabs } from './tabs.ts';
import '../host/a2ui.ts';

/**
 * The service worker: the extension's gateway and store. It holds the
 * surfaces (the apps', and the browser's own) and the customizations the
 * extension ships with, which the options page approves, and answers the
 * content scripts and the side panel. It also keeps the activity log
 * (every write and refusal, with undo), and runs triggers when
 * `chrome.alarms` wakes it. Nothing here listens to web pages: the
 * manifest has no externally_connectable and no web-accessible
 * resources, so only the extension's own content scripts and pages reach
 * it.
 *
 * Manifest V3 forbids generated code, so schemas are validated with the
 * cfworker engine instead of Ajv.
 */

setSchemaEngine(cfworkerEngine());

const PACKAGED = 'packaged';
const ALARM = 'graft-triggers';
const RUNS_LIMIT = 100;

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

// Storage updates in order: two calls finishing together must not drop each other's log entry.
let writes: Promise<unknown> = Promise.resolve();
function update<T>(key: string, fallback: T, change: (value: T) => T): Promise<void> {
	const next = writes.then(async () => {
		const current = ((await chrome.storage.local.get(key))[key] as T | undefined) ?? fallback;
		await chrome.storage.local.set({ [key]: change(current) });
	});
	writes = next.catch(() => {});
	return next;
}

const read = async <T>(key: string, fallback: T): Promise<T> => {
	await writes;
	return ((await chrome.storage.local.get(key))[key] as T | undefined) ?? fallback;
};

/**
 * Installs the packaged bundles that validate for a shipped surface. A
 * customization keeps its grants while its spec version is the same;
 * a new spec version waits for approval again.
 */
async function installPackaged(): Promise<void> {
	const { surfaces, bundles } = await loadPackaged();
	const customizations = await stored();
	const shipped = new Set<string>();
	for (const bundle of bundles) {
		for (const surface of surfaces) {
			const { installed, problems } = await fromBundle(bundle, surface, PACKAGED);
			if (!installed) {
				if (bundle.builds.some((b) => b.build.surface.hash === surface.hash)) {
					console.warn(`Graft: not installing "${bundle.title}":`, problems.join(' '));
				}
				continue;
			}
			shipped.add(installed.id);
			const previous = customizations[installed.id];
			const keep = previous && previous.specHash === installed.specHash && previous.grant;
			customizations[installed.id] = keep
				? {
						...installed,
						grant: previous.grant,
						...(previous.triggerGrants ? { triggerGrants: previous.triggerGrants } : {}),
						...(previous.approvedAt ? { approvedAt: previous.approvedAt } : {}),
					}
				: installed;
		}
	}
	// What an update of the extension withdrew, or ships in a form that no longer installs, goes with its grant.
	for (const [id, installed] of Object.entries(customizations)) {
		if (installed.from === PACKAGED && !shipped.has(id)) {
			delete customizations[id];
		}
	}
	await store(customizations);
	// Woken every 15 minutes to start the triggers that are due; schedules are at least an hour apart. Created
	// once: creating it again on every start of the service worker would push it back each time, and a busy
	// browser would never let it fire.
	if (surfaces.some((surface) => surface.triggers) && !(await chrome.alarms.get(ALARM))) {
		await chrome.alarms.create(ALARM, { periodInMinutes: 15 });
	}
}

let ready: Promise<void> | undefined;
const whenReady = () => (ready ??= installPackaged());

chrome.runtime.onInstalled.addListener(() => {
	ready = installPackaged();
});

const appSurfaces = async () => (await loadPackaged()).surfaces.filter((surface) => surface.host === HOST);
const browserSurface = async () => (await loadPackaged()).surfaces.find((surface) => surface.host === CHROME);

async function surfaceFor(url: string): Promise<Surface | undefined> {
	return (await appSurfaces()).find((surface) => appModel(surface).app.origins.some((origin) => originMatches(origin, url)));
}

async function surfaceOf(installed: Installed): Promise<Surface | undefined> {
	return (await loadPackaged()).surfaces.find((surface) => surface.hash === installed.build.surface.hash);
}

async function recordDrift(event: Omit<DriftEvent, 'at'>): Promise<void> {
	await update<DriftEvent[]>('drift', [], (drift) => [...drift, { at: new Date().toISOString(), ...event }].slice(-50));
}

async function recordActivity(entry: Activity): Promise<void> {
	await update<Activity[]>('activity', [], (log) => appendActivity(log, entry));
}

/** The gateway's report of a call, into the activity log when it belongs there. */
function recorder(installed: Installed, surface: Surface, source: ActivitySource, origin?: string) {
	return (record: CallRecord) => {
		if (worthRecording(record)) {
			void recordActivity(activityFrom(record, { customization: installed.id, title: installed.title, source, surface, ...(origin ? { origin } : {}) }));
		}
	};
}

async function pageFor(url: string): Promise<{ surface: Surface; mounts: Mount[] } | undefined> {
	const surface = await surfaceFor(url);
	if (!surface) {
		return undefined;
	}
	return { surface, mounts: await mountsFor(Object.values(await stored()), surface, url) };
}

/** An app page's context for one customization: calls to the page's origin, recorded as the person's. */
function appPage(surface: Surface, url: string, installed: Installed): PageContext {
	return {
		surface,
		url,
		fetch: (input, init) => fetch(input, init),
		onDrift: (capability, details) => void recordDrift({ kind: 'capability', symbol: capability, url, details }),
		onCall: recorder(installed, surface, { kind: 'view' }, new URL(url).origin),
	};
}

/** The side panel's context for one customization: the browser's tab functions. */
function panelContext(surface: Surface, installed: Installed): Context {
	return { surface, perform: tabsPerform(chromeTabs()), role: async () => undefined, onCall: recorder(installed, surface, { kind: 'view' }) };
}

/** The customizations served in the side panel. */
async function panelMounts(): Promise<{ surface: Surface; mounts: Mount[] } | undefined> {
	const surface = await browserSurface();
	if (!surface) {
		return undefined;
	}
	const mounts: Mount[] = [];
	for (const installed of Object.values(await stored())) {
		const slot = installed.build.mount.slot;
		if (installed.build.surface.hash === surface.hash && browserModel(surface).pages[slot] === 'sidepanel.html' && (await unservable(installed, surface)) === undefined) {
			mounts.push({ installed, slot, props: {} });
		}
	}
	return { surface, mounts };
}

const CONTENT_MESSAGES = new Set(['mounts', 'render', 'act', 'anchor']);

const stateOf = (state: unknown) => (typeof state === 'object' && state !== null && !Array.isArray(state) ? (state as Record<string, unknown>) : {});

async function fromContent(message: ContentMessage, url: string): Promise<unknown> {
	if (!CONTENT_MESSAGES.has(message.type)) {
		throw new Error('Unknown message.');
	}
	const found = await pageFor(url);
	if (!found) {
		return message.type === 'mounts' ? [] : Promise.reject(new Error('This page is not part of an app the extension knows.'));
	}
	const { surface, mounts } = found;
	if (message.type === 'mounts') {
		return mounts.map((m): MountInfo => ({ id: m.installed.id, title: (m.installed.build.mount.title as string | undefined) ?? m.installed.title, slot: m.slot, anchor: m.anchor! }));
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
	const page = appPage(surface, url, mount.installed);
	const state = stateOf(message.state);
	if (message.type === 'render') {
		const rendered = await renderMount(page, mount, state);
		return { view: rendered.view, state: rendered.state };
	}
	if (message.type === 'act' && typeof message.key === 'string') {
		return act(page, mount, message.key, state);
	}
	throw new Error('Unknown message.');
}

async function fromPanel(message: Extract<PageMessage, { type: `panel-${string}` }>): Promise<unknown> {
	const found = await panelMounts();
	if (message.type === 'panel-mounts') {
		return (found?.mounts ?? []).map((m): PanelInfo => ({ id: m.installed.id, title: (m.installed.build.mount.title as string | undefined) ?? m.installed.title }));
	}
	const mount = found?.mounts.find((m) => m.installed.id === message.id);
	if (!found || !mount) {
		throw new Error('That customization is not in the side panel.');
	}
	const context = panelContext(found.surface, mount.installed);
	const state = stateOf(message.state);
	if (message.type === 'panel-render') {
		const rendered = await renderMount(context, mount, state);
		return { view: rendered.view, state: rendered.state };
	}
	if (message.type === 'panel-act' && typeof message.key === 'string') {
		return act(context, mount, message.key, state);
	}
	throw new Error('Unknown message.');
}

// Triggers ---------------------------------------------------------------------------------------

async function triggerStates(): Promise<Record<string, TriggerState>> {
	return read<Record<string, TriggerState>>('triggers', {});
}

async function saveTriggerState(key: string, state: TriggerState): Promise<void> {
	await update<Record<string, TriggerState>>('triggers', {}, (states) => ({ ...states, [key]: state }));
}

async function recordRun(record: RunRecord): Promise<void> {
	await update<RunRecord[]>('runs', [], (runs) => [...runs, record].slice(-RUNS_LIMIT));
}

/** Runs one trigger now: on its schedule, because someone asked, or as a dry run that changes nothing. */
async function runTrigger(installed: Installed, surface: Surface, trigger: string, how: RunRecord['how'], now: number): Promise<RunRecord> {
	const states = await triggerStates();
	const { run, state } = await runInstalledTrigger({
		installed,
		surface,
		trigger,
		// Tabs "unused for more than N days" count to the run's clock.
		perform: tabsPerform(chromeTabs(), () => now),
		state: stateFor(installed, trigger, states),
		now,
		dryRun: how === 'dry-run',
		onCall: recorder(installed, surface, { kind: 'trigger', trigger }),
	});
	if (how !== 'dry-run') {
		await saveTriggerState(triggerKey(installed.id, trigger), state);
	}
	const record: RunRecord = { at: new Date(now).toISOString(), customization: installed.id, title: installed.title, trigger, how, run };
	await recordRun(record);
	return record;
}

/** Starts the triggers that are due; what an alarm does. */
async function tick(now: number = Date.now()): Promise<RunRecord[]> {
	await whenReady();
	if (await read('triggersPaused', false)) {
		return [];
	}
	const { surfaces } = await loadPackaged();
	const list = Object.values(await stored());
	const due = await dueTriggers(list, (installed) => surfaces.find((s) => s.hash === installed.build.surface.hash), await triggerStates(), now);
	const records: RunRecord[] = [];
	for (const { installed, surface, trigger } of due) {
		records.push(await runTrigger(installed, surface, trigger, 'schedule', now));
	}
	return records;
}

chrome.alarms?.onAlarm.addListener((alarm) => {
	if (alarm.name === ALARM) {
		void tick();
	}
});

// Undo -------------------------------------------------------------------------------------------

const undoing = new Set<string>();

/** Puts back what a logged write did, with the reverse its capability declares, as the person; once, however often it is asked. */
async function undo(id: string): Promise<Activity> {
	if (undoing.has(id)) {
		throw new Error('It is being undone.');
	}
	undoing.add(id);
	try {
		return await undoOnce(id);
	} finally {
		undoing.delete(id);
	}
}

async function undoOnce(id: string): Promise<Activity> {
	const log = await read<Activity[]>('activity', []);
	const entry = log.find((e) => e.id === id);
	const surface = entry ? (await loadPackaged()).surfaces.find((s) => s.hash === entry.surface) : undefined;
	const refused = undoRefusal(entry, surface);
	if (refused) {
		throw new Error(refused);
	}
	const reverse = entry!.undo!;
	const declared = surface!.capabilities[reverse.capability];
	const refusal = compileSchema(declared!.input as object)(reverse.input) ? undefined : new CallError('graft_invalid_input', `Invalid input for "${reverse.capability}".`);
	if (surface!.host === HOST && (!entry!.origin || !appModel(surface!).app.origins.some((origin) => originMatches(origin, `${entry!.origin}/`)))) {
		throw new Error('The app this was done in is not one the extension knows any more.');
	}
	const perform = surface!.host === CHROME ? tabsPerform(chromeTabs()) : httpPerform(entry!.origin!, (input, init) => fetch(input, init));
	const installed = { id: entry!.customization, title: entry!.title } as Installed;
	let error: string | undefined;
	try {
		await guarded(reverse.capability, declared, reverse.input, refusal, perform, { onCall: recorder(installed, surface!, { kind: 'undo', of: entry!.id }, entry!.origin) });
	} catch (caught) {
		error = (caught as Error).message;
	}
	const done: Activity = { ...entry!, undo: { ...reverse, ...(error ? { error } : { done: new Date().toISOString() }) } };
	await update<Activity[]>('activity', [], (current) => current.map((e) => (e.id === id ? done : e)));
	if (error) {
		throw new Error(`It could not be undone: ${error}`);
	}
	return done;
}

// The options page -------------------------------------------------------------------------------

async function listed(): Promise<Listed[]> {
	const customizations = await stored();
	const states = await triggerStates();
	const result: Listed[] = [];
	for (const installed of Object.values(customizations)) {
		const surface = await surfaceOf(installed);
		const blocked = surface ? await unservable(installed, surface) : 'The extension does not know this version of the app.';
		const triggers = [];
		for (const id of Object.keys(installed.build.triggers ?? {})) {
			const described = describeTrigger(installed, surface, id);
			const state = stateFor(installed, id, states);
			const why = surface ? await unrunnable(installed, surface, id) : blocked;
			const schedule = installed.build.triggers?.[id]?.schedule;
			const next = state.nextRun ?? (schedule && installed.approvedAt ? nextRun(schedule, Date.parse(installed.approvedAt), false) : undefined);
			triggers.push({
				id,
				...described,
				...(why ? { blocked: why } : {}),
				...(state.paused ? { paused: state.paused.reason } : {}),
				...(state.lastRun ? { lastRun: new Date(state.lastRun).toISOString() } : {}),
				...(next && !why && !state.paused ? { nextRun: new Date(next).toISOString() } : {}),
			});
		}
		result.push({
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
			triggers,
			...(triggers.length > 0 && surface?.triggers?.identity ? { identity: surface.triggers.identity } : {}),
		});
	}
	return result;
}

async function activity(): Promise<ActivityReply> {
	const { surfaces } = await loadPackaged();
	const log = await read<Activity[]>('activity', []);
	return {
		activity: [...log].reverse().map((entry) => ({
			...entry,
			text: describeActivity(entry),
			canUndo: undoRefusal(entry, surfaces.find((s) => s.hash === entry.surface)) === undefined,
		})),
		runs: [...(await read<RunRecord[]>('runs', []))].reverse(),
		paused: await read('triggersPaused', false),
	};
}

async function fromOptions(message: OptionsMessage, now: number = Date.now()): Promise<unknown> {
	if (message.type === 'list') {
		return listed();
	}
	if (message.type === 'activity') {
		return activity();
	}
	if (message.type === 'undo') {
		return undo(String(message.entry));
	}
	if (message.type === 'pause-all') {
		await update('triggersPaused', false, () => message.paused === true);
		return null;
	}
	const customizations = await stored();
	const installed = customizations[message.id];
	if (!installed) {
		throw new Error('No such customization.');
	}
	if (message.type === 'trigger') {
		const surface = await surfaceOf(installed);
		const trigger = String(message.trigger);
		if (!surface || !installed.build.triggers?.[trigger]) {
			throw new Error(`It has no trigger "${trigger}".`);
		}
		const key = triggerKey(installed.id, trigger);
		const state = stateFor(installed, trigger, await triggerStates());
		if (message.op === 'pause') {
			await saveTriggerState(key, { ...state, paused: { at: new Date(now).toISOString(), reason: 'Paused by you.' } });
			return null;
		}
		if (message.op === 'resume') {
			const { paused: _paused, ...rest } = state;
			await saveTriggerState(key, { ...rest, failures: 0 });
			return null;
		}
		const why = await unrunnable(installed, surface, trigger);
		if (why) {
			throw new Error(why);
		}
		if (message.op === 'run' && state.paused) {
			throw new Error('It is paused: resume it first, or try a dry run.');
		}
		if (message.op === 'run' || message.op === 'dry-run') {
			return runTrigger(installed, surface, trigger, message.op === 'run' ? 'manual' : 'dry-run', now);
		}
		throw new Error('Unknown message.');
	}
	if (message.type === 'approve') {
		// The grants are what the spec asks for, as the person read it on the page: for its views, and for each trigger apart.
		const triggerGrants = Object.fromEntries(Object.entries(installed.manifest.triggers ?? {}).map(([id, trigger]) => [id, [...trigger.permissions]]));
		customizations[message.id] = {
			...installed,
			grant: [...installed.manifest.permissions],
			...(Object.keys(triggerGrants).length > 0 ? { triggerGrants } : {}),
			approvedAt: new Date(now).toISOString(),
		};
	} else if (message.type === 'revoke') {
		const { approvedAt: _approvedAt, triggerGrants: _triggerGrants, ...rest } = installed;
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
			const type = String((message as { type?: unknown }).type);
			if (type.startsWith('panel-')) {
				return { ok: true, value: await fromPanel(message as Extract<PageMessage, { type: `panel-${string}` }>) };
			}
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

// The toolbar button opens the side panel.
void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/**
 * For the end-to-end tests and debugging from the service worker's own
 * console; not reachable from pages. `runTrigger` and `tick` take a clock,
 * so a test can run "a week later" without waiting a week.
 */
(globalThis as { graft?: unknown }).graft = {
	handle,
	stored,
	store,
	installPackaged,
	tick,
	runTrigger: async (id: string, trigger: string, options: { now?: number; dryRun?: boolean } = {}) => {
		const installed = (await stored())[id];
		const surface = installed ? await surfaceOf(installed) : undefined;
		const why = installed && surface ? await unrunnable(installed, surface, trigger) : 'No such customization.';
		if (why) {
			throw new Error(why);
		}
		return runTrigger(installed!, surface!, trigger, options.dryRun ? 'dry-run' : 'manual', options.now ?? Date.now());
	},
};
