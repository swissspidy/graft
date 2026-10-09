import { fileURLToPath } from 'node:url';
import { formatCanaryReport, type Build, type Surface, type Value } from '@swissspidy/graft-core';
import { loadCorpus, runEmDashCanary, scenarios } from './canary.ts';
import { loadSurface } from './examples.ts';
import { startSandbox } from './sandbox.ts';

/**
 * Runs every synthetic scenario against the EmDash canary corpus in one
 * EmDash sandbox and checks each customization reaches the expected
 * outcome.
 *
 * Regeneration normally calls the compiler (Claude). Here a scripted
 * regenerator stands in: it turns a "status" data input into "statuses",
 * which is what a compiler reading the new input schema has to do, and
 * gives up on anything else.
 */

const corpus = await loadCorpus(fileURLToPath(new URL('../../../../../fixtures/canary/emdash', import.meta.url)));
const from = await loadSurface();

async function scriptedRegenerate({ previous, surface }: { previous: Build; surface: Surface }): Promise<Build | undefined> {
	const input = surface.capabilities['content.list']?.input as { properties?: Record<string, unknown> } | undefined;
	if (!input?.properties?.statuses) {
		return undefined;
	}
	const build = structuredClone(previous);
	for (const source of Object.values(build.data)) {
		const value = source.input as Record<string, Value> | undefined;
		if (value && 'status' in value) {
			value.statuses = [value.status!];
			delete value.status;
		}
	}
	build.provenance = { compiler: 'scripted-regenerator', strategy: 'regenerated' };
	return build;
}

const sandbox = await startSandbox();
let mismatches = 0;
try {
	for (const scenario of scenarios) {
		const { report } = await runEmDashCanary({ corpus, from, scenario, sandbox, regenerate: scriptedRegenerate });
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
