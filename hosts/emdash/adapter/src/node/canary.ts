import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCanary, validateSpec, verifyBuild, type Build, type CanaryOptions, type CanaryReport, type CorpusEntry, type Migration, type Surface, type UpgradeOutcome } from '@swissspidy/graft-core';
import { createCan } from '../host/can.ts';
import type { HostPatch } from '../host/patch.ts';
import '../host/a2ui.ts';
import { startSandbox, type EmDashSandbox } from './sandbox.ts';

/**
 * A synthetic EmDash change: a patch the sandbox applies (src/host/patch.ts),
 * the migrations the new surface declares, and the outcome each example
 * spec should reach (used by the canary test).
 */
export interface Scenario {
	name: string;
	description: string;
	patch: HostPatch;
	migrations: Migration[];
	expect: Record<string, UpgradeOutcome>;
}

export const scenarios: Scenario[] = [
	{
		name: 'noop',
		description: 'Nothing the customizations use changes.',
		patch: {},
		migrations: [],
		expect: { 'publish-queue': 'survived', 'go-live': 'survived', 'drafts-glance': 'survived', 'status-board': 'survived' },
	},
	{
		name: 'rename-list-capability',
		description: 'content.list is renamed to content.query, with a declared migration.',
		patch: { capabilities: { rename: { 'content.list': 'content.query' } } },
		migrations: [{ op: 'rename', kind: 'capability', from: 'content.list', to: 'content.query' }],
		expect: { 'publish-queue': 'migrated', 'go-live': 'survived', 'drafts-glance': 'migrated', 'status-board': 'migrated' },
	},
	{
		name: 'move-editor-panel',
		description: 'The editor panel slot is deprecated in favor of content.editor.sidebar.',
		patch: { slots: { alias: { 'content.editor.sidebar': 'content.editor.panel' }, deprecate: { 'content.editor.panel': 'content.editor.sidebar' } } },
		migrations: [],
		expect: { 'publish-queue': 'survived', 'go-live': 'reanchored', 'drafts-glance': 'survived', 'status-board': 'survived' },
	},
	{
		name: 'change-list-input',
		description: 'content.list takes "statuses" (a list) instead of "status"; no migration describes it.',
		patch: { capabilities: { statuses: true } },
		migrations: [],
		expect: { 'publish-queue': 'regenerated', 'go-live': 'survived', 'drafts-glance': 'regenerated', 'status-board': 'regenerated' },
	},
	{
		name: 'widen-publish-scope',
		description: 'Publishing and unpublishing now also need a new content.publish:write scope.',
		patch: {
			scopes: { add: { 'content.publish:write': { title: 'Publish content', host: ['content:publish_own', 'content:publish_any'] } } },
			capabilities: {
				scopes: {
					'content.publish': ['content.status:write', 'content.publish:write'],
					'content.unpublish': ['content.status:write', 'content.publish:write'],
				},
			},
		},
		migrations: [],
		expect: { 'publish-queue': 'needs_approval', 'go-live': 'needs_approval', 'drafts-glance': 'survived', 'status-board': 'needs_approval' },
	},
	{
		name: 'remove-publish',
		description: 'content.publish is removed without replacement.',
		patch: { capabilities: { remove: ['content.publish'] } },
		migrations: [],
		expect: { 'publish-queue': 'failed', 'go-live': 'failed', 'drafts-glance': 'survived', 'status-board': 'failed' },
	},
];

/**
 * Loads a corpus directory: one directory per tenant with spec files and
 * their active builds (`<name>.md` next to `<name>.json`), and optionally the
 * grant (`<name>.grant.json`). Without it, the grant is what the spec
 * requests, as if approved. Same layout as the WordPress corpus.
 */
export async function loadCorpus(dir: string): Promise<CorpusEntry[]> {
	const entries: CorpusEntry[] = [];
	for (const tenant of (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
		for (const file of (await readdir(join(dir, tenant))).filter((f) => f.endsWith('.md')).sort()) {
			const source = await readFile(join(dir, tenant, file), 'utf8');
			const build = JSON.parse(await readFile(join(dir, tenant, file.replace(/\.md$/, '.json')), 'utf8')) as Build;
			let grant = validateSpec(source).spec?.manifest.permissions ?? [];
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

/** Surface B for a scenario: patch the sandbox, then read the surface it reports. */
export async function scenarioSurface(sandbox: EmDashSandbox, from: Surface, scenario: Scenario): Promise<Surface> {
	await sandbox.patch(scenario.patch);
	const surface = await sandbox.surface();
	return { ...surface, hostVersion: `${surface.hostVersion}+${scenario.name}`, previous: from.hash!, migrations: scenario.migrations };
}

export interface EmDashCanaryOptions {
	corpus: CorpusEntry[];
	from: Surface;
	/** A surface for another EmDash version... */
	to?: Surface;
	/** ...or a synthetic change applied to the `from` host. */
	scenario?: Scenario;
	regenerate?: CanaryOptions['regenerate'];
	chooseSlot?: CanaryOptions['chooseSlot'];
	onEntry?: CanaryOptions['onEntry'];
	sandbox?: EmDashSandbox;
}

/** Runs the canary in an EmDash sandbox: the installed EmDash, or it with a synthetic change. */
export async function runEmDashCanary(options: EmDashCanaryOptions): Promise<{ report: CanaryReport; to: Surface }> {
	const { from } = options;
	if (!options.to && !options.scenario) {
		throw new Error('Pass a target surface or a scenario.');
	}
	const sandbox = options.sandbox ?? (await startSandbox());
	try {
		const to = options.scenario ? await scenarioSurface(sandbox, from, options.scenario) : options.to!;
		const report = await runCanary({
			corpus: options.corpus,
			from,
			to,
			verify: (build, spec, grant) => verifyBuild({ build, spec, surface: to, sandbox, createCan, grant }),
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
