import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { hashSpec, validateSpec } from '@graft/core';

export const examplesDir = fileURLToPath(new URL('../../../../examples', import.meta.url));

export interface ExampleFixture {
	source: string;
	/** Frontmatter as parsed by the core; PHP has no YAML parser. */
	manifest: Record<string, unknown>;
	title: string;
	hash: string;
	build: Record<string, unknown> | null;
}

/** The example specs and their hand-written builds, prepared for PHP. */
export async function exampleFixtures(): Promise<Record<string, ExampleFixture>> {
	const fixtures: Record<string, ExampleFixture> = {};
	for (const file of (await readdir(`${examplesDir}/specs`)).filter((f) => f.endsWith('.md'))) {
		const source = await readFile(`${examplesDir}/specs/${file}`, 'utf8');
		const { spec } = validateSpec(source);
		if (!spec) {
			throw new Error(`Invalid example spec ${file}`);
		}
		let build: Record<string, unknown> | null = null;
		try {
			build = JSON.parse(await readFile(`${examplesDir}/builds/${file.replace(/\.md$/, '.json')}`, 'utf8')) as Record<string, unknown>;
		} catch {
			// No hand-written build for this spec.
		}
		fixtures[spec.manifest.id] = {
			source,
			manifest: spec.manifest as unknown as Record<string, unknown>,
			title: spec.title,
			hash: await hashSpec(source),
			build,
		};
	}
	return fixtures;
}
