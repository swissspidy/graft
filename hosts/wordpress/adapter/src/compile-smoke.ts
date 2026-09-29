import { readFile } from 'node:fs/promises';
import { compileSpec, hashSpec, validateSpec, type Build, type Check, type ModelClient, type TreeNode } from '@graft/core';
import { examplesDir } from './fixtures.ts';
import { hostGuide } from './guide.ts';
import { paths } from './playground.ts';
import { startSandbox } from './sandbox.ts';
import { verifyInWordPress } from './verify.ts';

/**
 * Runs the whole compile pipeline against a real WordPress sandbox with a
 * scripted model (no API key needed): the model replays the hand-written
 * review-queue build as structured output, but its first tree omits the
 * status filter. The compiler must reject that candidate in verification,
 * feed the failure back, and accept the second.
 */

function flatten(tree: TreeNode) {
	const nodes: Array<{ id: string; parent: string | null; type: string; props_json: string; text: string | null }> = [];
	const visit = (node: TreeNode, parent: string | null) => {
		const id = `n${nodes.length}`;
		nodes.push({ id, parent, type: node.type, props_json: JSON.stringify(node.props ?? {}), text: typeof node.children === 'string' ? node.children : null });
		if (Array.isArray(node.children)) {
			node.children.forEach((child) => visit(child, id));
		}
	};
	visit(tree, null);
	return nodes;
}

const checksAnswer = (checks: Check[]) => ({
	checks: checks.map((c) => ({
		criterion: c.criterion,
		fixtures_json: JSON.stringify(c.fixtures ?? {}),
		view_as: c.view_as ?? '',
		steps_json: JSON.stringify(c.steps ?? []),
		expect_json: JSON.stringify(c.expect),
	})),
});

const source = await readFile(`${examplesDir}/specs/review-queue.md`, 'utf8');
const handwritten = JSON.parse(await readFile(`${examplesDir}/builds/review-queue.json`, 'utf8')) as Build;
const surface = JSON.parse(await readFile(`${paths.surfaces}/7.1.json`, 'utf8'));
const spec = validateSpec(source, { surface }).spec!;

const treeAnswer = (input: unknown) => ({
	nodes: flatten(handwritten.tree),
	data: [{ name: 'queue', call: 'posts.list', input_json: JSON.stringify(input) }],
});
const answers = {
	checks: [checksAnswer(handwritten.checks)],
	tree: [treeAnswer({ orderby: 'date', order: 'asc' }), treeAnswer(handwritten.data.queue!.input)],
};
const prompts: string[] = [];
const model: ModelClient = {
	async generate(request) {
		prompts.push(request.prompt);
		return { output: answers[request.purpose].shift(), model: 'scripted' };
	},
};

const sandbox = await startSandbox();
try {
	const result = await compileSpec({
		spec,
		specHash: await hashSpec(source),
		surface,
		model,
		host: hostGuide,
		verify: async (build) => (await verifyInWordPress([{ build, spec, surface }], { sandbox }))[0]!,
		onEvent: (event) => console.log(JSON.stringify(event)),
	});
	const failures: string[] = [];
	if (!result.ok) failures.push('the compile did not succeed');
	if (result.attempts.filter((a) => a.phase === 'tree').length !== 2) failures.push('expected exactly two tree attempts');
	if (!prompts[2]?.includes('Check for "pending-only"')) failures.push('the verification failure was not fed back');
	if (JSON.stringify(result.build?.data) !== JSON.stringify(handwritten.data)) failures.push('the accepted build is not the corrected one');
	console.log(failures.length ? `✖ ${failures.join('; ')}` : '✔ compile pipeline: rejected the wrong tree in WordPress, accepted the fix');
	process.exitCode = failures.length ? 1 : 0;
} finally {
	await sandbox.close();
}
