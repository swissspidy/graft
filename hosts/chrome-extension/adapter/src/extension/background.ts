import { compileSchema, describeCheck, setSchemaEngine, validateSpec, type CustomizationBundle, type Surface } from '@swissspidy/graft-core';
import { cfworkerEngine } from '@swissspidy/graft-core/cfworker';
import { CHROME, browserModel } from '../browser/surface.ts';
import { tabsPerform } from '../browser/tabs.ts';
import { activityFrom, appendActivity, changedNothing, describeActivity, shownInput, undoRefusal, worthRecording, type Activity, type ActivitySource } from '../host/activity.ts';
import { describers } from '../host/describe.ts';
import { act, asPreview, fromBundle, guarded, httpPerform, mountsFor, previewGrant, renderMount, unservable, unverified, type CallRecord, type Context, type Installed, type Mount, type PageContext } from '../host/gateway.ts';
import { CallError } from '../host/http.ts';
import { originMatches } from '../host/pages.ts';
import { describeTrigger, dueTriggers, nextRun, runInstalledTrigger, stateFor, triggerKey, unrunnable, type TriggerState } from '../host/runner.ts';
import { HOST, appModel } from '../host/surface.ts';
import type { ActivityReply, ContentMessage, DriftEvent, Listed, MountInfo, OptionsMessage, PageMessage, PanelInfo, Reply, RunRecord } from './messages.ts';
import { createQueue } from './queue.ts';
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

// Storage in order (./queue.ts): two changes at once never drop each other.
const queue = createQueue({ get: (key) => chrome.storage.local.get(key), set: (items) => chrome.storage.local.set(items) });
const { update, read } = queue;

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
	if (surfaces.some((surface) => surface.triggers)) {
		// Apart from readiness: a scheduling failure must not stop the views and the options page from working.
		void scheduleTriggers();
	}
}

/** The alarm that starts due triggers; retried on the next start of the service worker if setting it failed. */
async function scheduleTriggers(): Promise<void> {
	try {
		if (!(await chrome.alarms.get(ALARM))) {
			await chrome.alarms.create(ALARM, { periodInMinutes: 15 });
		}
	} catch (error) {
		console.error('Graft: triggers cannot be scheduled:', error);
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
			recordActivity(activityFrom(record, { customization: installed.id, title: installed.title, source, surface, ...(origin ? { origin } : {}) })).catch((error: unknown) => {
				// The call is done and is not repeated; what is lost is its entry (and its Undo), which is said here.
				console.error(`Graft: "${record.capability}" by ${installed.id} could not be added to the activity log:`, error);
			});
		}
	};
}

// Safe mode and previews -------------------------------------------------------------------------

/** How long a preview lasts once the person asks for it. */
const PREVIEW_MINUTES = 10;

const SAFE_MODE_REASON = 'Safe mode is on: nothing is shown or run.';

/** Safe mode: nothing is served, previewed or run; the options page, approval and undo still work. */
const safeMode = () => read('safeMode', false);

interface Preview {
	/** When it ends, in ms since the epoch. */
	until: number;
	/** The spec version it was asked for: a new version needs asking again. */
	specHash: string;
}

/** The customizations the person asked to preview, and that are still being previewed. */
async function activePreviews(now: number = Date.now()): Promise<Set<string>> {
	const previews = await read<Record<string, Preview>>('previews', {});
	const customizations = await stored();
	return new Set(Object.entries(previews).filter(([id, p]) => p.until > now && customizations[id]?.specHash === p.specHash && !customizations[id]?.grant).map(([id]) => id));
}

const titleOf = (m: Mount) => `${(m.installed.build.mount.title as string | undefined) ?? m.installed.title}${m.preview ? ' (preview)' : ''}`;

async function pageFor(url: string): Promise<{ surface: Surface; mounts: Mount[] } | undefined> {
	const surface = await surfaceFor(url);
	if (!surface) {
		return undefined;
	}
	if (await safeMode()) {
		return { surface, mounts: [] };
	}
	return { surface, mounts: await mountsFor(Object.values(await stored()), surface, url, await activePreviews()) };
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
	if (await safeMode()) {
		return { surface, mounts };
	}
	const previews = await activePreviews();
	for (const installed of Object.values(await stored())) {
		const slot = installed.build.mount.slot;
		if (installed.build.surface.hash !== surface.hash || browserModel(surface).pages[slot] !== 'sidepanel.html') {
			continue;
		}
		if ((await unservable(installed, surface)) === undefined) {
			mounts.push({ installed, slot, props: {} });
		} else if (!installed.grant && previews.has(installed.id) && (await unverified(installed, surface)) === undefined) {
			mounts.push({ installed: asPreview(installed, surface), slot, props: {}, preview: true });
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
		return mounts.map((m): MountInfo => ({ id: m.installed.id, title: titleOf(m), slot: m.slot, anchor: m.anchor!, ...(m.preview ? { preview: true } : {}) }));
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
		return (found?.mounts ?? []).map((m): PanelInfo => ({ id: m.installed.id, title: titleOf(m), ...(m.preview ? { preview: true } : {}) }));
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
	// Tabs "unused for more than N days" count to the run's clock.
	const tabs = tabsPerform(chromeTabs(), () => now);
	const granted = installed.triggerGrants?.[trigger] ?? [];
	/** Why the run must stop before its next call: safe mode, a pause, or a grant revoked since it started. */
	const stopped = async (peek: <V>(key: string, fallback: V) => Promise<V>): Promise<string | undefined> => {
		if (await peek('safeMode', false)) {
			return SAFE_MODE_REASON;
		}
		const current = (await peek<Record<string, Installed>>('customizations', {}))[installed.id];
		if (!current?.grant || current.specHash !== installed.specHash || !granted.every((scope) => current.triggerGrants?.[trigger]?.includes(scope))) {
			return 'Its approval was revoked.';
		}
		if (how === 'schedule' && ((await peek('triggersPaused', false)) || stateFor(current, trigger, await peek<Record<string, TriggerState>>('triggers', {})).paused)) {
			return 'It was paused.';
		}
		return undefined;
	};
	const { run, state } = await runInstalledTrigger({
		installed,
		surface,
		trigger,
		// Checked before every call, in the same step of the storage queue as the call: nothing starts after safe
		// mode, a pause or a revocation is saved, and none of them is saved while a call is starting.
		perform: (name, capability, input) =>
			queue.exclusive(async (peek) => {
				const why = await stopped(peek);
				if (why) {
					throw new CallError('graft_trigger_stopped', why);
				}
				return tabs(name, capability, input);
			}),
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
	if ((await read('triggersPaused', false)) || (await safeMode())) {
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
	// Marked before the reverse runs: if saving its outcome fails afterwards, the entry is not offered again.
	const started = new Date().toISOString();
	await update<Activity[]>('activity', [], (current) => current.map((e) => (e.id === id ? { ...e, undo: { ...reverse, started } } : e)));
	let error: string | undefined;
	let changed = true;
	try {
		await guarded(reverse.capability, declared, reverse.input, refusal, perform, { onCall: recorder(installed, surface!, { kind: 'undo', of: entry!.id }, entry!.origin) });
	} catch (caught) {
		error = (caught as Error).message;
		// Only a refusal known to change nothing lets it be tried again; anything else may have taken effect.
		changed = !changedNothing(caught);
	}
	// The full reverse input is kept only while the entry can still be undone: after a refusal that changed nothing.
	const kept = error && !changed ? reverse : { ...reverse, input: shownInput(reverse.input) };
	const done: Activity = { ...entry!, undo: { ...kept, ...(error ? { error, ...(changed ? { started } : {}) } : { done: new Date().toISOString() }) } };
	await update<Activity[]>('activity', [], (current) => current.map((e) => (e.id === id ? done : e)));
	if (error) {
		throw new Error(`It could not be undone: ${error}`);
	}
	return done;
}

// The options page -------------------------------------------------------------------------------

async function listed(now: number = Date.now()): Promise<Listed[]> {
	const customizations = await stored();
	const states = await triggerStates();
	const safe = await safeMode();
	const previews = await read<Record<string, Preview>>('previews', {});
	const previewing = await activePreviews(now);
	const result: Listed[] = [];
	for (const installed of Object.values(customizations)) {
		const surface = await surfaceOf(installed);
		const unserved = surface ? await unservable(installed, surface) : 'The extension does not know this version of the app.';
		const blocked = safe && installed.grant ? (unserved ?? SAFE_MODE_REASON) : unserved;
		const canPreview = !installed.grant && surface !== undefined && (await unverified(installed, surface)) === undefined;
		const triggers = [];
		for (const id of Object.keys(installed.build.triggers ?? {})) {
			const described = describeTrigger(installed, surface, id);
			const state = stateFor(installed, id, states);
			const why = surface ? ((await unrunnable(installed, surface, id)) ?? (safe ? SAFE_MODE_REASON : undefined)) : blocked;
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
			...(canPreview && !safe
				? {
						preview: {
							reads: previewGrant(installed, surface!).map((scope) => surface!.scopes[scope]?.title ?? scope),
							minutes: PREVIEW_MINUTES,
							...(previewing.has(installed.id) ? { until: new Date(previews[installed.id]!.until).toISOString() } : {}),
						},
					}
				: {}),
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
		// What the page needs to show, not the raw inputs: those stay in the service worker, for Undo.
		activity: [...log].reverse().map((full) => {
			const { input: _input, undo, ...entry } = full;
			return {
				...entry,
				...(undo ? { undo: { capability: undo.capability, ...(undo.done ? { done: undo.done } : {}), ...(undo.error ? { error: undo.error } : {}) } } : {}),
				text: describeActivity(full),
				canUndo: undoRefusal(full, surfaces.find((s) => s.hash === full.surface)) === undefined,
			};
		}),
		runs: [...(await read<RunRecord[]>('runs', []))].reverse(),
		paused: await read('triggersPaused', false),
		safeMode: await safeMode(),
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
		// The page redraws from the log; the entry itself, with the reverse call's input, stays here.
		await undo(String(message.entry));
		return null;
	}
	if (message.type === 'safe-mode') {
		await update('safeMode', false, () => message.on === true);
		return null;
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
		if (message.op === 'run' && (await safeMode())) {
			throw new Error(SAFE_MODE_REASON);
		}
		if (message.op === 'run' && state.paused) {
			throw new Error('It is paused: resume it first, or try a dry run.');
		}
		if (message.op === 'run' || message.op === 'dry-run') {
			return runTrigger(installed, surface, trigger, message.op === 'run' ? 'manual' : 'dry-run', now);
		}
		throw new Error('Unknown message.');
	}
	if (message.type === 'preview') {
		if (message.on === true) {
			const surface = await surfaceOf(installed);
			const why = installed.grant ? 'It is approved already.' : (await safeMode()) ? SAFE_MODE_REASON : surface ? await unverified(installed, surface) : 'The extension does not know this version of the app.';
			if (why) {
				throw new Error(why);
			}
		}
		await update<Record<string, Preview>>('previews', {}, (previews) => {
			const { [installed.id]: _previous, ...rest } = previews;
			return message.on === true ? { ...rest, [installed.id]: { until: now + PREVIEW_MINUTES * 60_000, specHash: installed.specHash } } : rest;
		});
		return null;
	}
	if (message.type !== 'approve' && message.type !== 'revoke') {
		throw new Error('Unknown message.');
	}
	// In the storage queue, on the map as it is then: two approvals at once must not drop each other.
	await update<Record<string, Installed>>('customizations', {}, (latest) => {
		const current = latest[message.id];
		if (!current) {
			return latest;
		}
		if (message.type === 'revoke') {
			const { approvedAt: _approvedAt, triggerGrants: _triggerGrants, ...rest } = current;
			return { ...latest, [message.id]: { ...rest, grant: null } };
		}
		// The grants are what the spec asks for, as the person read it on the page: for its views, and for each trigger apart.
		const triggerGrants = Object.fromEntries(Object.entries(current.manifest.triggers ?? {}).map(([id, trigger]) => [id, [...trigger.permissions]]));
		return {
			...latest,
			[message.id]: { ...current, grant: [...current.manifest.permissions], ...(Object.keys(triggerGrants).length > 0 ? { triggerGrants } : {}), approvedAt: new Date(now).toISOString() },
		};
	});
	if (message.type === 'approve') {
		// Approving ends its preview, once the approval is saved.
		await update<Record<string, Preview>>('previews', {}, (previews) => {
			const { [installed.id]: _previous, ...rest } = previews;
			return rest;
		});
	}
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
		const why = (await safeMode()) && !options.dryRun ? SAFE_MODE_REASON : installed && surface ? await unrunnable(installed, surface, trigger) : 'No such customization.';
		if (why) {
			throw new Error(why);
		}
		return runTrigger(installed!, surface!, trigger, options.dryRun ? 'dry-run' : 'manual', options.now ?? Date.now());
	},
};
