import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileSpec, type Build, type CanaryReport, type ModelClient, type Spec, type Surface } from '@graft/core';
import { loadSurface } from './validate.ts';

export interface CanaryCommandOptions {
	corpus: string;
	from: string;
	to?: string;
	scenario?: string;
	/** Model for the regenerate rung; without one, regeneration does not apply. */
	model?: ModelClient;
	/** Write the upgraded builds here, per tenant. */
	out?: string;
	log?(line: string): void;
}

/**
 * Runs the upgrade ladder for every customization in a corpus against the
 * next host (a surface file) or a synthetic scenario, in a WordPress
 * sandbox, and reports the outcome per tenant and spec.
 */
export async function canaryCommand(options: CanaryCommandOptions): Promise<CanaryReport> {
	const wordpress = await import('@graft/wordpress-adapter');
	const from = await loadSurface(options.from);
	const to = options.to ? await loadSurface(options.to) : undefined;
	const scenario = options.scenario ? wordpress.scenarios.find((s) => s.name === options.scenario) : undefined;
	if (options.scenario && !scenario) {
		throw new Error(`Unknown scenario "${options.scenario}". Available: ${wordpress.scenarios.map((s) => s.name).join(', ')}.`);
	}
	const corpus = await wordpress.loadCorpus(options.corpus);
	const model = options.model;

	const { report } = await wordpress.runWordPressCanary({
		corpus,
		from,
		...(to ? { to } : {}),
		...(scenario ? { scenario } : {}),
		...(model
			? {
					regenerate: async ({ spec, specHash, previous, checks, surface }: { spec: Spec; specHash: string; previous: Build; checks: Build['checks']; surface: Surface }) => {
						const result = await compileSpec({ spec, specHash, surface, model, host: wordpress.hostGuide, previous, checks });
						return result.ok ? result.build : undefined;
					},
				}
			: {}),
		onEntry: (entry) => options.log?.(`${entry.tenant} / ${entry.spec}: ${entry.outcome}`),
	});

	if (options.out) {
		for (const entry of report.entries) {
			if (entry.build && entry.outcome !== 'failed') {
				await mkdir(join(options.out, entry.tenant), { recursive: true });
				await writeFile(join(options.out, entry.tenant, `${entry.spec}.json`), JSON.stringify(entry.build, null, '\t') + '\n');
			}
		}
		await writeFile(join(options.out, 'report.json'), JSON.stringify({ ...report, entries: report.entries.map(({ build: _b, ...e }) => e) }, null, '\t') + '\n');
	}
	return report;
}
