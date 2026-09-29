import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { hashSpec, validateSpec, type Build, type Check, type Surface, type TreeNode, type Verification } from '@graft/core';
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
export async function exampleFixtures(options: { verifyAgainst?: Surface } = {}): Promise<Record<string, ExampleFixture>> {
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

/**
 * A build expressed as the compiler's model output (flat nodes, JSON
 * strings), for scripted models in tests.
 */
export function modelAnswers(build: Build, dataInput?: Record<string, unknown>) {
	const nodes: Array<{ id: string; parent: string | null; type: string; props_json: string; text: string | null }> = [];
	const visit = (node: TreeNode, parent: string | null) => {
		const id = `n${nodes.length}`;
		nodes.push({ id, parent, type: node.type, props_json: JSON.stringify(node.props ?? {}), text: typeof node.children === 'string' ? node.children : null });
		if (Array.isArray(node.children)) {
			node.children.forEach((child) => visit(child, id));
		}
	};
	visit(build.tree, null);
	return {
		checks: {
			checks: build.checks.map((c: Check) => ({
				criterion: c.criterion,
				fixtures_json: JSON.stringify(c.fixtures ?? {}),
				view_as: c.view_as ?? '',
				steps_json: JSON.stringify(c.steps ?? []),
				expect_json: JSON.stringify(c.expect),
			})),
		},
		tree: {
			nodes,
			data: Object.entries(build.data).map(([name, source]) => ({
				name,
				call: source.call,
				input_json: JSON.stringify(dataInput?.[name] ?? source.input ?? null),
			})),
		},
	};
}
