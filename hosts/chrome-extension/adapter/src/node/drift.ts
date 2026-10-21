import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import { canonicalJson, hashSurface, sha256, staticCheck, type Build, type JsonSchema, type LadderStart, type RefChange, type Surface } from '@swissspidy/graft-core';
import type { Resolved } from '../host/anchor.ts';
import { buildRequest, checkOutput, type Fetch } from '../host/http.ts';
import { appModel, httpBinding, type Anchor } from '../host/surface.ts';

/**
 * Drift detection for an app that has no versions. The surface is what an
 * adapter author declared; the app changes underneath without notice. A
 * probe signs in to the app (or a copy), visits a page for every slot and
 * resolves its anchor the way the content script does, and calls every
 * read capability and checks its answer the way the gateway does. Writes
 * are never probed: they are only exercised in a sandbox.
 *
 * What it finds is fingerprinted (structure only: which selector matched,
 * the element's tag, role and name; each answer's shape, never its
 * values). A different fingerprint is drift. The probe also writes the
 * surface it observed: anchors that moved are re-anchored, slots that are
 * gone and capabilities whose answers broke are removed or changed, so
 * the observed surface has a new hash and every build can go up the
 * upgrade ladder from the declared surface to it.
 */

export interface Probes {
	/** A path that signs the probe in (the fixture's `/login?as=ada`); real apps get a stored session instead. */
	session?: string;
	/** A page for each slot to look for its anchor on. */
	pages: Record<string, string>;
	/** An input for each read capability. Reads without one are not probed. */
	inputs: Record<string, unknown>;
}

export interface SlotObservation {
	page?: string;
	status: 'ok' | 'moved' | 'broken' | 'unprobed';
	selector?: string;
	via?: 'selector' | 'landmark';
	observed?: Resolved['observed'];
	reason?: string;
}

export interface CapabilityObservation {
	status: 'ok' | 'broken' | 'unprobed';
	/** The answer's shape (types and keys), used as the capability's output when it broke. */
	shape?: JsonSchema;
	problems?: string[];
	/** Keys the answer has that the surface does not declare (dropped by the gateway). */
	undeclared?: string[];
	reason?: string;
}

export interface Observation {
	fingerprint: string;
	slots: Record<string, SlotObservation>;
	capabilities: Record<string, CapabilityObservation>;
}

export interface ObserveOptions {
	/** The app's (or a copy's) base URL. */
	url: string;
	probes: Probes;
	/** A browser to use; otherwise Chromium is launched (CHROMIUM picks the executable). */
	browser?: Browser;
}

let resolver: Promise<string> | undefined;

/** anchor.ts as one script that defines `__graftResolveAnchor`, to evaluate in pages. */
function resolverScript(): Promise<string> {
	resolver ??= esbuild({
		entryPoints: [fileURLToPath(new URL('../host/anchor.ts', import.meta.url))],
		bundle: true,
		write: false,
		format: 'iife',
		globalName: '__graftAnchor',
		platform: 'browser',
		target: 'es2022',
		logLevel: 'warning',
	}).then((result) => `${result.outputFiles[0]!.text};globalThis.__graftResolveAnchor = __graftAnchor.resolveAnchor;`);
	return resolver;
}

/** The shape of a JSON value: types and keys, never values. Items of a list are merged. */
export function shapeOf(value: unknown): JsonSchema {
	if (value === null) {
		return { type: 'null' };
	}
	if (Array.isArray(value)) {
		return value.length === 0 ? { type: 'array' } : { type: 'array', items: value.map(shapeOf).reduce(mergeShapes) };
	}
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
		return { type: 'object', properties: Object.fromEntries(entries.map(([key, inner]) => [key, shapeOf(inner)])), required: entries.map(([key]) => key) };
	}
	return { type: typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : (typeof value as 'string' | 'boolean') };
}

function mergeShapes(a: JsonSchema, b: JsonSchema): JsonSchema {
	if (canonicalJson(a) === canonicalJson(b) || typeof a === 'boolean' || typeof b === 'boolean') {
		return a;
	}
	const types = [...new Set([a.type, b.type].flat())].filter((t): t is string => typeof t === 'string').sort();
	const merged: Record<string, unknown> = { type: types.length === 1 ? types[0] : types };
	if (a.properties || b.properties) {
		const pa = (a.properties ?? {}) as Record<string, JsonSchema>;
		const pb = (b.properties ?? {}) as Record<string, JsonSchema>;
		merged.properties = Object.fromEntries(
			[...new Set([...Object.keys(pa), ...Object.keys(pb)])].sort().map((key) => [key, pa[key] && pb[key] ? mergeShapes(pa[key], pb[key]) : (pa[key] ?? pb[key])!]),
		);
		const ra = new Set((a.required as string[] | undefined) ?? []);
		merged.required = ((b.required as string[] | undefined) ?? []).filter((key) => ra.has(key));
	}
	if (a.items || b.items) {
		merged.items = a.items && b.items ? mergeShapes(a.items as JsonSchema, b.items as JsonSchema) : (a.items ?? b.items);
	}
	return merged;
}

/**
 * Paths of keys an answer has that its schema does not declare
 * (`/tasks/[]/dueDate`): what the app added. With the answer's problems,
 * this is what the fingerprint keeps of an answer, so it does not depend
 * on the probe account's data (a null here, an empty list there).
 */
export function undeclaredKeys(schema: unknown, value: unknown, path = ''): string[] {
	if (typeof schema !== 'object' || schema === null) {
		return [];
	}
	const s = schema as { properties?: Record<string, unknown>; items?: unknown; anyOf?: unknown[]; oneOf?: unknown[] };
	const branches = s.anyOf ?? s.oneOf;
	if (branches) {
		return [...new Set(branches.flatMap((branch) => undeclaredKeys(branch, value, path)))].sort();
	}
	if (Array.isArray(value)) {
		return [...new Set(value.flatMap((item) => undeclaredKeys(s.items, item, `${path}/[]`)))].sort();
	}
	if (typeof value === 'object' && value !== null && s.properties) {
		const properties = s.properties;
		return Object.entries(value as Record<string, unknown>)
			.flatMap(([key, inner]) => (Object.hasOwn(properties, key) ? undeclaredKeys(properties[key], inner, `${path}/${key}`) : [`${path}/${key}`]))
			.sort();
	}
	return [];
}

/** A Fetch over a browser context's request API, which shares the context's cookies (its session). */
function contextFetch(context: BrowserContext): Fetch {
	return async (url, init) => {
		const response = await context.request.fetch(url, {
			method: init.method ?? 'GET',
			headers: init.headers as Record<string, string>,
			...(init.body ? { data: init.body as string } : {}),
			maxRedirects: 0,
		});
		return new Response(new Uint8Array(await response.body()), { status: response.status(), headers: response.headers() });
	};
}

/** Probes the app at `url`: every slot's anchor on its page, every read capability with its probe input. */
export async function observe(surface: Surface, options: ObserveOptions): Promise<Observation> {
	const model = appModel(surface);
	const own = !options.browser;
	const browser = options.browser ?? (await chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) }));
	const context = await browser.newContext();
	try {
		const page = await context.newPage();
		if (options.probes.session) {
			await page.goto(new URL(options.probes.session, options.url).href);
		}
		const script = await resolverScript();
		const slots: Record<string, SlotObservation> = {};
		for (const [id, anchor] of Object.entries(model.anchors).sort(([a], [b]) => a.localeCompare(b))) {
			const path = options.probes.pages[id];
			if (!path) {
				slots[id] = { status: 'unprobed', reason: 'No probe page.' };
				continue;
			}
			await page.goto(new URL(path, options.url).href);
			slots[id] = { page: path, ...(await resolveIn(page, script, anchor)) };
		}
		const fetch = contextFetch(context);
		const capabilities: Record<string, CapabilityObservation> = {};
		for (const [id, capability] of Object.entries(surface.capabilities).sort(([a], [b]) => a.localeCompare(b))) {
			if (capability.kind === 'write') {
				capabilities[id] = { status: 'unprobed', reason: 'Writes are only exercised in a sandbox.' };
				continue;
			}
			if (!(id in options.probes.inputs)) {
				capabilities[id] = { status: 'unprobed', reason: 'No probe input.' };
				continue;
			}
			const { url, init } = buildRequest(httpBinding(capability), options.probes.inputs[id], options.url);
			const response = await fetch(url, init);
			if (!response.ok) {
				capabilities[id] = { status: 'broken', problems: [`The app answered ${response.status}.`] };
				continue;
			}
			const parsed = await response.json().then(
				(value: unknown) => ({ ok: true as const, value }),
				() => ({ ok: false as const }),
			);
			if (!parsed.ok) {
				// A sign-in page after the session expired, say: broken, with no shape to replace the declared output.
				capabilities[id] = { status: 'broken', problems: ['The app did not answer with JSON.'] };
				continue;
			}
			const body = parsed.value;
			// Positions in lists are data, not structure: "/tasks/3 …" and "/tasks/0 …" are the same problem.
			const problems = [...new Set(checkOutput(capability, body).problems.map((p) => p.replace(/\/\d+(?=\/|\s|$)/g, '/[]')))].sort();
			const undeclared = undeclaredKeys(capability.output, body);
			capabilities[id] = { status: problems.length === 0 ? 'ok' : 'broken', shape: shapeOf(body), ...(problems.length ? { problems } : {}), ...(undeclared.length ? { undeclared } : {}) };
		}
		const fingerprint = `sha256:${await sha256(
			canonicalJson({
				slots: Object.fromEntries(Object.entries(slots).map(([id, s]) => [id, { selector: s.selector ?? null, via: s.via ?? null, observed: s.observed ?? null, status: s.status === 'broken' ? 'broken' : null }])),
				capabilities: Object.fromEntries(Object.entries(capabilities).map(([id, c]) => [id, { status: c.status, problems: c.problems ?? [], undeclared: c.undeclared ?? [] }])),
			}),
		)}`;
		return { fingerprint, slots, capabilities };
	} finally {
		await context.close();
		if (own) {
			await browser.close();
		}
	}
}

async function resolveIn(page: import('@playwright/test').Page, script: string, anchor: Anchor): Promise<Omit<SlotObservation, 'page'>> {
	// Apps draw late: wait a moment for the anchor before calling it broken.
	const deadline = Date.now() + 3_000;
	for (;;) {
		const resolved = (await page.evaluate(`(() => { ${script}; const r = __graftResolveAnchor(${JSON.stringify(anchor)}, document); delete r.element; return r; })()`)) as Omit<Resolved, 'element'>;
		if (resolved.status !== 'broken' || Date.now() > deadline) {
			return resolved;
		}
		await page.waitForTimeout(150);
	}
}

/** A host version for an app with none: the fingerprint it was observed with. */
export const observedVersion = (fingerprint: string) => `observed-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 12)}`;

/**
 * The surface the app actually offers, from what the probe observed:
 * moved anchors re-anchored (the selector that found them goes first),
 * slots whose anchor is gone removed, capabilities whose answers broke
 * given the observed shape. Hashed, with the declared surface as previous.
 */
export async function observedSurface(surface: Surface, observation: Observation): Promise<Surface> {
	const model = appModel(surface);
	const anchors: Record<string, Anchor> = {};
	const slots: Surface['slots'] = {};
	for (const [id, slot] of Object.entries(surface.slots)) {
		const anchor = model.anchors[id];
		const seen = observation.slots[id];
		if (!anchor || seen?.status === 'broken') {
			continue;
		}
		slots[id] = slot;
		anchors[id] = seen?.status === 'moved' && seen.selector ? { ...anchor, selectors: [seen.selector, ...anchor.selectors.filter((s) => s !== seen.selector)] } : anchor;
	}
	const capabilities: Surface['capabilities'] = {};
	for (const [id, capability] of Object.entries(surface.capabilities)) {
		const seen = observation.capabilities[id];
		capabilities[id] = seen?.status === 'broken' && seen.shape ? { ...capability, output: seen.shape } : capability;
	}
	const observed: Surface = {
		...surface,
		hostVersion: observedVersion(observation.fingerprint),
		fingerprint: observation.fingerprint,
		...(surface.hash ? { previous: surface.hash } : {}),
		slots,
		capabilities,
		model: { ...model, anchors } as unknown as Record<string, unknown>,
	};
	delete observed.hash;
	return { ...observed, hash: await hashSurface(observed) };
}

export interface BuildDrift {
	spec: string;
	/** Where the upgrade ladder starts for it (ADR 0001, section 7). */
	start: LadderStart;
	changes: RefChange[];
}

export interface DriftReport {
	app: string;
	url: string;
	/** The fingerprint the surface was declared with, and the one observed now. */
	recorded?: string;
	observed: string;
	drifted: boolean;
	slots: Record<string, SlotObservation>;
	capabilities: Record<string, CapabilityObservation>;
	/** The observed surface, for the upgrade ladder. */
	surface: Surface;
	builds: BuildDrift[];
}

/** Probes the app, and for each build where the upgrade ladder starts on the observed surface. */
export async function checkDrift(surface: Surface, builds: Build[], options: ObserveOptions): Promise<DriftReport> {
	const observation = await observe(surface, options);
	const observed = await observedSurface(surface, observation);
	return {
		app: appModel(surface).app.id,
		url: options.url,
		...(surface.fingerprint ? { recorded: surface.fingerprint } : {}),
		observed: observation.fingerprint,
		drifted: surface.fingerprint !== observation.fingerprint,
		slots: observation.slots,
		capabilities: observation.capabilities,
		surface: observed,
		builds: builds.map((build) => {
			const check = staticCheck(build, surface, observed);
			return { spec: build.spec.id, start: check.start, changes: check.changes };
		}),
	};
}

const MARK: Record<string, string> = { ok: '✓', moved: '↪', broken: '✗', unprobed: '·' };

export function formatDriftReport(report: DriftReport): string {
	const lines = [
		report.drifted ? `${report.app} drifted from its surface (${report.recorded ?? 'no recorded fingerprint'} → ${report.observed}).` : `${report.app} matches its surface (${report.observed}).`,
		'',
		'Slots:',
	];
	for (const [id, slot] of Object.entries(report.slots)) {
		const how = slot.status === 'moved' ? `re-anchored by ${slot.via}${slot.selector ? ` to ${slot.selector}` : ', but no unique selector was found'}` : slot.status === 'ok' ? slot.selector : slot.reason;
		lines.push(`  ${MARK[slot.status]} ${id}: ${slot.status}${how ? ` (${how})` : ''}`);
	}
	lines.push('Capabilities:');
	for (const [id, capability] of Object.entries(report.capabilities)) {
		const how = capability.problems?.slice(0, 3).join('; ') ?? (capability.undeclared ? `new: ${capability.undeclared.join(', ')}` : capability.reason);
		lines.push(`  ${MARK[capability.status]} ${id}: ${capability.status}${how ? ` (${how})` : ''}`);
	}
	if (report.builds.length > 0) {
		lines.push('Builds (upgrade ladder start on the observed surface):');
		for (const build of report.builds) {
			const changes = build.changes.map((c) => `${c.kind} ${c.symbol} ${c.change}${c.compatible ? ' (compatible)' : ''}`).join(', ');
			lines.push(`  ${build.spec}: ${build.start}${changes ? ` (${changes})` : ''}`);
		}
	}
	lines.push(`Observed surface: ${report.surface.hash} (${report.surface.hostVersion}).`);
	return lines.join('\n');
}
