import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateSpec, type Build, type Spec, type Surface } from '@graft/core';

/** The EmDash examples (examples/emdash) with the current surface. */

export const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
export const EXAMPLES = ['publish-queue', 'go-live', 'drafts-glance'] as const;

export interface Example {
	name: string;
	source: string;
	spec: Spec;
	build: Build;
	surface: Surface;
}

export async function loadSurface(): Promise<Surface> {
	return JSON.parse(await readFile(`${ROOT}hosts/emdash/adapter/surfaces/1.0.json`, 'utf8')) as Surface;
}

export async function loadExamples(surface?: Surface): Promise<Example[]> {
	const current = surface ?? (await loadSurface());
	const examples: Example[] = [];
	for (const name of EXAMPLES) {
		const source = await readFile(`${ROOT}examples/emdash/specs/${name}.md`, 'utf8');
		const spec = validateSpec(source, { surface: current }).spec;
		if (!spec) {
			throw new Error(`examples/emdash/specs/${name}.md is not valid.`);
		}
		const build = JSON.parse(await readFile(`${ROOT}examples/emdash/builds/${name}.json`, 'utf8')) as Build;
		examples.push({ name, source, spec, build, surface: current });
	}
	return examples;
}
