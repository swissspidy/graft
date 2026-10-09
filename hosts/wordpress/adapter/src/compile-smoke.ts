import { readFile } from 'node:fs/promises';
import { compileSpec, hashSpec, validateSpec, type Build, type ModelClient } from '@graft/core';
import { examplesDir, modelAnswers } from './fixtures.ts';
import { hostGuide } from './guide.ts';
import { paths } from './playground.ts';
import { startSandbox } from './sandbox.ts';
import { verifyInWordPress } from './verify.ts';

/**
 * Runs the whole compile pipeline against a real WordPress sandbox with a
 * scripted model (no API key needed): the model replays the review-queue
 * build (an A2UI surface, the host's format for new builds) as structured
 * output, but its first answer omits the status filter. The compiler must
 * reject that candidate in verification, feed the failure back, and accept
 * the second.
 */

const source = await readFile(`${examplesDir}/specs/review-queue.md`, 'utf8');
const handwritten = JSON.parse(await readFile(`${examplesDir}/a2ui/builds/review-queue.json`, 'utf8')) as Build;
const surface = JSON.parse(await readFile(`${paths.surfaces}/7.1.json`, 'utf8'));
const spec = validateSpec(source, { surface }).spec!;

const answers = {
	checks: [modelAnswers(handwritten).checks],
	tree: [modelAnswers(handwritten, { queue: { orderby: 'date', order: 'asc' } }).tree, modelAnswers(handwritten).tree],
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
	if (result.attempts.filter((a) => a.phase === 'tree').length !== 2) failures.push('expected exactly two UI attempts');
	if (!result.build?.ui || result.build.tree) failures.push('the build is not an A2UI surface');
	if (!prompts[2]?.includes('Check for "pending-only"')) failures.push('the verification failure was not fed back');
	if (JSON.stringify(result.build?.data) !== JSON.stringify(handwritten.data)) failures.push('the accepted build is not the corrected one');
	console.log(failures.length ? `✖ ${failures.join('; ')}` : '✔ compile pipeline: rejected the wrong A2UI surface in WordPress, accepted the fix');

	// A tree with code: the first answer's function never returns. The
	// sandbox stops it, verification fails, and the compiler asks again.
	const headlineSource = await readFile(`${examplesDir}/specs/headline-check.md`, 'utf8');
	const headline = JSON.parse(await readFile(`${examplesDir}/builds/headline-check.json`, 'utf8')) as Build;
	const headlineSpec = validateSpec(headlineSource, { surface }).spec!;
	const looping = { ...(modelAnswers(headline).tree as object), code: { source: 'function headlineVerdict(title) { for (;;) {} }', functions: ['headlineVerdict'] } };
	const codeAnswers = { checks: [modelAnswers(headline).checks], tree: [looping, modelAnswers(headline).tree] };
	const codePrompts: string[] = [];
	const withCode = await compileSpec({
		spec: headlineSpec,
		specHash: await hashSpec(headlineSource),
		surface,
		model: {
			async generate(request) {
				codePrompts.push(request.prompt);
				return { output: codeAnswers[request.purpose].shift(), model: 'scripted' };
			},
		},
		host: hostGuide,
		format: 'tree',
		verify: async (build) => (await verifyInWordPress([{ build, spec: headlineSpec, surface }], { sandbox }))[0]!,
		onEvent: (event) => console.log(JSON.stringify(event)),
	});
	const codeFailures: string[] = [];
	if (!withCode.ok) codeFailures.push('the compile with code did not succeed');
	if (!codePrompts[2]?.includes('ran longer than')) codeFailures.push('the stopped function was not fed back');
	if (JSON.stringify(withCode.build?.code) !== JSON.stringify(headline.code)) codeFailures.push('the accepted build does not carry the working code');
	console.log(codeFailures.length ? `✖ ${codeFailures.join('; ')}` : '✔ compile pipeline with code: stopped the looping function, accepted the fix');
	failures.push(...codeFailures);
	process.exitCode = failures.length ? 1 : 0;
} finally {
	await sandbox.close();
}
