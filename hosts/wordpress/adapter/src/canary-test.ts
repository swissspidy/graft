import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { formatCanaryReport, type Build, type Surface, type Value } from '@swissspidy/graft-core';
import './a2ui.ts';
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
 */

const corpusDir = fileURLToPath(new URL('../../../../fixtures/canary/tenants', import.meta.url));
const corpus = await loadCorpus(corpusDir);
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
			const expected = scenario.expect[entry.spec];
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
