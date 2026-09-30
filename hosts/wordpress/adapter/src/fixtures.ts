import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { hashSpec, validateSpec, type Build, type Surface, type Verification } from '@graft/core';
import { verifyInWordPress } from './verify.ts';

export const examplesDir = fileURLToPath(new URL('../../../../examples', import.meta.url));

export interface ExampleFixture {
	source: string;
	/** Frontmatter as parsed by the core; PHP has no YAML parser. */
	manifest: Record<string, unknown>;
	title: string;
	hash: string;
	build: Record<string, unknown> | null;
	/** Present when the fixtures were prepared with verification. */
	verification?: Verification;
}

/**
 * The example specs and their hand-written builds, prepared for PHP. With a
 * surface, every build is verified in a WordPress sandbox first and the
 * verification record is included.
 */
export async function exampleFixtures(options: { verifyAgainst?: Surface; dir?: string } = {}): Promise<Record<string, ExampleFixture>> {
	const dir = options.dir ?? examplesDir;
	const fixtures: Record<string, ExampleFixture> = {};
	for (const file of (await readdir(`${dir}/specs`)).filter((f) => f.endsWith('.md'))) {
		const source = await readFile(`${dir}/specs/${file}`, 'utf8');
		const { spec } = validateSpec(source);
		if (!spec) {
			throw new Error(`Invalid example spec ${file}`);
		}
		let build: Record<string, unknown> | null = null;
		try {
			build = JSON.parse(await readFile(`${dir}/builds/${file.replace(/\.md$/, '.json')}`, 'utf8')) as Record<string, unknown>;
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
	const surface = options.verifyAgainst;
	if (surface) {
		const withBuilds = Object.values(fixtures).filter((f) => f.build);
		const verifications = await verifyInWordPress(
			withBuilds.map((f) => ({ build: f.build as unknown as Build, spec: validateSpec(f.source).spec!, surface })),
		);
		withBuilds.forEach((fixture, i) => {
			fixture.verification = verifications[i]!;
			if (!verifications[i]!.passed) {
				throw new Error(`The example build for ${fixture.manifest.id} does not pass verification.`);
			}
		});
	}
	return fixtures;
}

export { modelAnswers } from '@graft/core';
