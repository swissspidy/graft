import { readFile } from 'node:fs/promises';
import { compileSpec, hashSpec, validateSpec, type Build, type ModelClient } from '@swissspidy/graft-core';
import { examplesDir, modelAnswers } from './fixtures.ts';
import { hostGuide } from './guide.ts';
import { paths } from './playground.ts';
import { startSandbox } from './sandbox.ts';
import { verifyInWordPress } from './verify.ts';

/**
 * Runs the whole compile pipeline against a real WordPress sandbox with a
 * scripted model (no API key needed): the model replays the review-queue
 * build (an A2UI surface) as structured
 * output, but its first answer omits the status filter. The compiler must
 * reject that candidate in verification, feed the failure back, and accept
 * the second.
 */

const source = await readFile(`${examplesDir}/specs/review-queue.md`, 'utf8');
const handwritten = JSON.parse(await readFile(`${examplesDir}/builds/review-queue.json`, 'utf8')) as Build;
const surface = JSON.parse(await readFile(`${paths.surfaces}/7.1.json`, 'utf8'));
const spec = validateSpec(source, { surface }).spec!;

const answers = {
	checks: [modelAnswers(handwritten).checks],
	ui: [modelAnswers(handwritten, { queue: { orderby: 'date', order: 'asc' } }).ui, modelAnswers(handwritten).ui],
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
	if (result.attempts.filter((a) => a.phase === 'ui').length !== 2) failures.push('expected exactly two UI attempts');
	if (!result.build?.ui) failures.push('the build is not an A2UI surface');
	if (!prompts[2]?.includes('Check for "pending-only"')) failures.push('the verification failure was not fed back');
	if (JSON.stringify(result.build?.data) !== JSON.stringify(handwritten.data)) failures.push('the accepted build is not the corrected one');
	console.log(failures.length ? `✖ ${failures.join('; ')}` : '✔ compile pipeline: rejected the wrong A2UI surface in WordPress, accepted the fix');

	process.exitCode = failures.length ? 1 : 0;
} finally {
	await sandbox.close();
}
