import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { formatCanaryReport, validateSpec, type Build, type CorpusEntry, type Surface, type UpgradeOutcome, type Value } from '@graft/core';
import './a2ui.ts';
import { examplesDir } from './fixtures.ts';
import { loadCorpus, runWordPressCanary, scenarios } from './canary.ts';
import { paths } from './playground.ts';
import { startSandbox } from './sandbox.ts';

/**
 * Runs every synthetic scenario against the canary corpus in one WordPress
 * sandbox and checks each customization reaches the expected outcome.
 *
 * Regeneration normally calls the compiler (Claude). Here a scripted
 * regenerator stands in: it renames "status" to "statuses" in data inputs,
 * which is what a compiler reading the new input schema has to do, and
 * gives up on anything else.
 *
 * With --a2ui, the corpus is the example specs built as A2UI surfaces
 * (examples/a2ui/builds), one tenant: the same ladder, with A2UI's
 * outcomes (no build has code, so none depends on the host running it).
 */

const a2ui = process.argv.includes('--a2ui');
const corpusDir = fileURLToPath(new URL('../../../../fixtures/canary/tenants', import.meta.url));
const corpus = a2ui ? await a2uiCorpus() : await loadCorpus(corpusDir);

async function a2uiCorpus(): Promise<CorpusEntry[]> {
	const entries: CorpusEntry[] = [];
	for (const file of (await readdir(`${examplesDir}/a2ui/builds`)).filter((f) => f.endsWith('.json')).sort()) {
		const source = await readFile(`${examplesDir}/specs/${file.replace(/\.json$/, '.md')}`, 'utf8');
		const build = JSON.parse(await readFile(`${examplesDir}/a2ui/builds/${file}`, 'utf8')) as Build;
		entries.push({ tenant: 'a2ui', source, build, grant: validateSpec(source).spec!.manifest.permissions });
	}
	return entries;
}

/** A read-only posts.list build's outcomes (stale-drafts, waiting-posts are not in the tree corpus). */
const readOnlyList: Record<string, UpgradeOutcome> = {
	noop: 'survived',
	'rename-list-capability': 'migrated',
	'move-row-actions': 'survived',
	'change-list-input': 'regenerated',
	'widen-publish-scope': 'survived',
	'remove-status-update': 'survived',
	'no-functions': 'survived',
	'no-widgets': 'survived',
};

/** What a customization should reach: as a tree, or as A2UI, which never needs the host to run code. */
function expectedOutcome(scenario: (typeof scenarios)[number], spec: string): UpgradeOutcome | undefined {
	if (!a2ui) {
		return scenario.expect[spec];
	}
	if (scenario.name === 'no-functions' || scenario.name === 'no-widgets') {
		return 'survived';
	}
	return scenario.expect[spec] ?? readOnlyList[scenario.name];
}
const from = JSON.parse(await readFile(`${paths.surfaces}/7.1.json`, 'utf8')) as Surface;

async function scriptedRegenerate({ previous, surface }: { previous: Build; surface: Surface }): Promise<Build | undefined> {
	const input = surface.capabilities['posts.list']?.input as { properties?: Record<string, unknown> } | undefined;
	if (!input?.properties?.statuses) {
		return undefined;
	}
	const build = structuredClone(previous);
	for (const source of Object.values(build.data)) {
		const value = source.input as Record<string, Value> | undefined;
		if (value && 'status' in value) {
			value.statuses = value.status!;
			delete value.status;
		}
	}
	build.provenance = { compiler: 'scripted-regenerator', strategy: 'regenerated' };
	return build;
}

const sandbox = await startSandbox();
let mismatches = 0;
try {
	// --scenario <name> runs one.
	const only = process.argv.includes('--scenario') ? process.argv[process.argv.indexOf('--scenario') + 1] : undefined;
	for (const scenario of scenarios.filter((s) => !only || s.name === only)) {
		const { report } = await runWordPressCanary({ corpus, from, scenario, sandbox, regenerate: scriptedRegenerate });
		console.log(`\n## ${scenario.name}: ${scenario.description}\n`);
		console.log(formatCanaryReport(report));
		for (const entry of report.entries) {
			const expected = expectedOutcome(scenario, entry.spec);
			if (entry.outcome !== expected) {
				mismatches++;
				console.log(`✖ ${entry.tenant} / ${entry.spec}: expected ${expected}, got ${entry.outcome}`);
				console.log(entry.path.map((p) => `    ${p.state}: ${p.note}`).join('\n'));
			}
		}
	}
} finally {
	await sandbox.close();
}
console.log(mismatches ? `\n${mismatches} unexpected outcome(s)` : '\nEvery scenario reached the expected outcomes.');
process.exitCode = mismatches ? 1 : 0;
