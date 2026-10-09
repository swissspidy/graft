import { compileSpec, hashSpec, modelAnswers, type ModelClient } from '@graft/core';
import { hostGuide } from '../host/guide.ts';
import { loadExamples } from './examples.ts';
import { startSandbox, verifyInEmDash } from './sandbox.ts';

/**
 * Runs the whole compile pipeline against a real EmDash sandbox with a
 * scripted model (no API key needed): the model replays the publish-queue
 * build (an A2UI surface, the host's format for new builds), but its first
 * answer lists every status. The compiler must reject that candidate in
 * verification, feed the failure back, and accept the second.
 */

const example = (await loadExamples()).find((e) => e.name === 'publish-queue')!;
const { source, spec, build: handwritten, surface } = example;

const answers = {
	checks: [modelAnswers(handwritten).checks],
	tree: [modelAnswers(handwritten, { queue: { collection: 'posts', order: 'asc' } }).tree, modelAnswers(handwritten).tree],
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
		verify: async (build) => (await verifyInEmDash([{ build, spec, surface }], { sandbox }))[0]!,
		onEvent: (event) => console.log(JSON.stringify(event)),
	});
	const failures: string[] = [];
	if (!result.ok) failures.push('the compile did not succeed');
	if (result.attempts.filter((a) => a.phase === 'tree').length !== 2) failures.push('expected exactly two UI attempts');
	if (!result.build?.ui || result.build.tree) failures.push('the build is not an A2UI surface');
	if (!prompts[2]?.includes('Check for "drafts-only"')) failures.push('the verification failure was not fed back');
	if (JSON.stringify(result.build?.data) !== JSON.stringify(handwritten.data)) failures.push('the accepted build is not the corrected one');
	console.log(failures.length ? `✖ ${failures.join('; ')}` : '✔ compile pipeline: rejected the wrong A2UI surface in EmDash, accepted the fix');
	process.exitCode = failures.length ? 1 : 0;
} finally {
	await sandbox.close();
}
