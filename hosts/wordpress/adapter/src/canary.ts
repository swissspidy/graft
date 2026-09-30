import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	hashSurface,
	runCanary,
	validateSpec,
	verifyBuild,
	type Build,
	type CanaryOptions,
	type CanaryReport,
	type CorpusEntry,
	type Migration,
	type Surface,
	type UpgradeOutcome,
} from '@graft/core';
import { createCan } from './can.ts';
import { playgroundVersion } from './playground.ts';
import { startSandbox, type WordPressSandbox } from './sandbox.ts';
import { semantics } from './semantics.ts';
import { loadFunctions } from '@graft/sandbox';
import { assembleSurface } from './surface.ts';

/**
 * A synthetic host change: a patch the sandbox applies through the plugin's
 * surface filters, the migrations the new surface declares, and the outcome
 * each example spec should reach (used by the canary test).
 */
export interface Scenario {
	name: string;
	description: string;
	patch: Record<string, unknown>;
	migrations: Migration[];
	expect: Record<string, UpgradeOutcome>;
	/** A change to the generated surface that no plugin filter can make. */
	surface?(surface: Surface): Surface;
}

export const scenarios: Scenario[] = [
	{
		name: 'noop',
		description: 'Nothing the customizations use changes.',
		patch: {},
		migrations: [],
		expect: { 'review-queue': 'survived', 'quick-approve': 'survived', 'editorial-inbox': 'survived', 'headline-check': 'survived', 'pending-by-author': 'survived' },
	},
	{
		name: 'rename-list-capability',
		description: 'posts.list is renamed to posts.query, with a declared migration.',
		patch: { capabilities: { rename: { 'posts.list': 'posts.query' } } },
		migrations: [{ op: 'rename', kind: 'capability', from: 'posts.list', to: 'posts.query' }],
		expect: { 'review-queue': 'migrated', 'quick-approve': 'survived', 'editorial-inbox': 'migrated', 'headline-check': 'migrated', 'pending-by-author': 'migrated' },
	},
	{
		name: 'move-row-actions',
		description: 'The row actions slot is deprecated in favor of posts.list.actions.',
		patch: { slots: { alias: { 'posts.list.actions': 'posts.list.row-actions' }, deprecate: { 'posts.list.row-actions': 'posts.list.actions' } } },
		migrations: [],
		expect: { 'review-queue': 'survived', 'quick-approve': 'reanchored', 'editorial-inbox': 'survived', 'headline-check': 'survived', 'pending-by-author': 'survived' },
	},
	{
		name: 'change-list-input',
		description: 'posts.list takes "statuses" instead of "status"; no migration describes it.',
		patch: { variants: ['posts-list-statuses'], capabilities: { ability: { 'posts.list': 'graft-canary/posts-list' } } },
		migrations: [],
		// The headline check is recompiled, and its code comes through.
		expect: { 'review-queue': 'regenerated', 'quick-approve': 'survived', 'editorial-inbox': 'regenerated', 'headline-check': 'regenerated', 'pending-by-author': 'regenerated' },
	},
	{
		name: 'widen-publish-scope',
		description: 'Changing post status now also needs a new posts.publish:write scope.',
		patch: {
			scopes: { add: { 'posts.publish:write': { title: 'Publish posts', host: ['publish_posts'] } } },
			capabilities: { scopes: { 'posts.update_status': ['posts.status:write', 'posts.publish:write'] } },
		},
		migrations: [],
		expect: { 'review-queue': 'needs_approval', 'quick-approve': 'needs_approval', 'editorial-inbox': 'needs_approval', 'headline-check': 'survived', 'pending-by-author': 'needs_approval' },
	},
	{
		name: 'remove-status-update',
		description: 'posts.update_status is removed without replacement.',
		patch: { capabilities: { remove: ['posts.update_status'] } },
		migrations: [],
		expect: { 'review-queue': 'failed', 'quick-approve': 'failed', 'editorial-inbox': 'failed', 'headline-check': 'survived', 'pending-by-author': 'failed' },
	},
	{
		name: 'no-functions',
		description: 'The host stops running build functions.',
		patch: {},
		migrations: [],
		surface: ({ functions: _, ...rest }) => rest,
		expect: { 'review-queue': 'survived', 'quick-approve': 'survived', 'editorial-inbox': 'survived', 'headline-check': 'failed', 'pending-by-author': 'failed' },
	},
	{
		name: 'no-widgets',
		description: 'The host still runs build functions, but no longer interactive widgets.',
		patch: {},
		migrations: [],
		surface: (surface) => {
			const { widgets: _, ...functions } = surface.functions!;
			return { ...surface, functions };
		},
		expect: { 'review-queue': 'survived', 'quick-approve': 'survived', 'editorial-inbox': 'survived', 'headline-check': 'survived', 'pending-by-author': 'failed' },
	},
];

/**
 * Loads a corpus directory: one directory per tenant with spec files and
 * their active builds (`<name>.md` next to `<name>.json`), and optionally the
 * grant (`<name>.grant.json`, as written by `graft site pull`). Without it,
 * the grant is the permissions the spec requests, as if approved.
 */
export async function loadCorpus(dir: string): Promise<CorpusEntry[]> {
	const entries: CorpusEntry[] = [];
	for (const tenant of (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
		for (const file of (await readdir(join(dir, tenant))).filter((f) => f.endsWith('.md')).sort()) {
			const source = await readFile(join(dir, tenant, file), 'utf8');
			const build = JSON.parse(await readFile(join(dir, tenant, file.replace(/\.md$/, '.json')), 'utf8')) as Build;
			const { spec } = validateSpec(source);
			let grant = spec?.manifest.permissions ?? [];
			try {
				grant = (JSON.parse(await readFile(join(dir, tenant, file.replace(/\.md$/, '.grant.json')), 'utf8')) as { scopes: string[] }).scopes;
			} catch {
				// No stored grant: assume the requested permissions were approved.
			}
			entries.push({ tenant, source, build, grant });
		}
	}
	return entries;
}

/** Surface B for a scenario: patch the sandbox, then generate the surface from it. */
export async function scenarioSurface(sandbox: WordPressSandbox, from: Surface, scenario: Scenario): Promise<Surface> {
	await sandbox.patch(scenario.patch);
	let surface = await assembleSurface(await sandbox.dump());
	if (scenario.surface) {
		surface = scenario.surface(surface);
		surface.hash = await hashSurface(surface);
	}
	return { ...surface, hostVersion: `${surface.hostVersion}+${scenario.name}`, previous: from.hash!, migrations: scenario.migrations };
}

export interface WordPressCanaryOptions {
	corpus: CorpusEntry[];
	from: Surface;
	/** A generated surface for another WordPress version... */
	to?: Surface;
	/** ...or a synthetic change applied to the `from` host. */
	scenario?: Scenario;
	regenerate?: CanaryOptions['regenerate'];
	chooseSlot?: CanaryOptions['chooseSlot'];
	onEntry?: CanaryOptions['onEntry'];
	sandbox?: WordPressSandbox;
}

/**
 * Runs the canary in a WordPress sandbox of the target host: the real next
 * version for `to`, or the current version with a synthetic change.
 */
export async function runWordPressCanary(options: WordPressCanaryOptions): Promise<{ report: CanaryReport; to: Surface }> {
	const { from } = options;
	if (!options.to && !options.scenario) {
		throw new Error('Pass a target surface or a scenario.');
	}
	const version = playgroundVersion((options.to ?? from).hostVersion);
	const sandbox = options.sandbox ?? (await startSandbox({ wp: version }));
	try {
		const to = options.scenario ? await scenarioSurface(sandbox, from, options.scenario) : options.to!;
		const report = await runCanary({
			corpus: options.corpus,
			from,
			to,
			verify: (build, spec, grant) => verifyBuild({ build, spec, surface: to, sandbox, semantics, createCan, grant, loadFunctions }),
			...(options.regenerate ? { regenerate: options.regenerate } : {}),
			...(options.chooseSlot ? { chooseSlot: options.chooseSlot } : {}),
			...(options.onEntry ? { onEntry: options.onEntry } : {}),
		});
		return { report, to };
	} finally {
		if (options.scenario) {
			await sandbox.patch({});
		}
		if (!options.sandbox) {
			await sandbox.close();
		}
	}
}
