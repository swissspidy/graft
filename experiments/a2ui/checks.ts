import { mkdir, readFile, writeFile } from 'node:fs/promises';
import buildSchema from '../../schemas/build.schema.json' with { type: 'json' };
import { assembleChecks, assembleUnverifiable, checksOutputSchema, validateSpec, verifyBuild, type Build, type Check, type Spec, type Surface } from '../../packages/core/src/index.ts';
import { lazyValidator } from '../../packages/core/src/schema.ts';
import { checksPrompt, checksSystem } from '../../packages/core/src/compiler/prompt.ts';
import { anthropicModel } from '../../packages/cli/src/anthropic.ts';
import { createCan } from '../../hosts/wordpress/adapter/src/can.ts';
import { hostGuide } from '../../hosts/wordpress/adapter/src/guide.ts';
import { startSandbox } from '../../hosts/wordpress/adapter/src/sandbox.ts';
import { semantics } from '../../hosts/wordpress/adapter/src/semantics.ts';
import { loadFunctions } from '../../packages/sandbox/src/index.ts';
import { CATALOG_GUIDE } from './catalog.ts';
import { verifyA2UI } from './compile.ts';
import { compileA2UI } from './compiler.ts';

/**
 * The whole compiler for A2UI: the checks phase as well, then the surface
 * against those fresh checks. The checks are written from the spec and a
 * description of what the build can use, which is now the A2UI catalog
 * instead of Graft's components. As a cross-check, the example's tree build
 * runs against the fresh checks too: checks that capture the spec, not the
 * UI format, should accept it.
 *
 *   ANTHROPIC_API_KEY=... npx tsx experiments/a2ui/checks.ts pending-by-author publish-checklist stale-drafts
 *
 * Output goes to experiments/a2ui/compiled/fresh/.
 */

const root = new URL('../../', import.meta.url);
const read = async (path: string) => readFile(new URL(path, root), 'utf8');
const surface = JSON.parse(await read('hosts/wordpress/plugin/surfaces/7.1.json')) as Surface;
const model = anthropicModel({});
const validateCheck = lazyValidator<Check>({ $defs: buildSchema.$defs, $ref: '#/$defs/check' });

/** The checks system prompt, describing the A2UI catalog where Graft's components were. */
function system(spec: Spec): string {
	const base = checksSystem(spec, surface, hostGuide).replace(/\nComponents \(props[\s\S]*?(?=\nCapabilities you may use)/, '');
	return `${base}\n\nThe customization's UI will be an A2UI surface:\n${CATALOG_GUIDE}\n\nIn checks, an action id is a button's or table row action's id, and an input id is a text field's or checkbox's id.`;
}

async function writeChecks(spec: Spec): Promise<{ checks?: Check[]; log: unknown[] }> {
	const log: unknown[] = [];
	let feedback: string[] = [];
	for (let attempt = 1; attempt <= 3; attempt++) {
		const response = await model.generate({ purpose: 'checks', system: system(spec), prompt: checksPrompt(spec, feedback), schema: checksOutputSchema(spec) });
		const unverifiable = assembleUnverifiable(response.output);
		const assembled = assembleChecks(response.output);
		const problems = [...unverifiable.map((u) => `Criterion "${u.criterion}" cannot be checked: ${u.reason}`), ...assembled.problems];
		for (const [i, check] of (assembled.value ?? []).entries()) {
			if (!validateCheck(check)) {
				problems.push(`Check ${i + 1} (${assembled.value![i]!.criterion}) is malformed.`);
			}
		}
		for (const { id } of spec.criteria) {
			if (assembled.value && !assembled.value.some((c) => c.criterion === id)) {
				problems.push(`Criterion "${id}" has no check.`);
			}
		}
		log.push({ attempt, problems, output: response.output });
		console.log(`  checks attempt ${attempt}: ${problems.length ? problems.join('; ') : `${assembled.value!.length} checks`}`);
		if (problems.length === 0) {
			return { checks: assembled.value!, log };
		}
		if (unverifiable.length) {
			return { log };
		}
		feedback = problems;
	}
	return { log };
}

const sandbox = await startSandbox({});
const out = new URL('experiments/a2ui/compiled/fresh/', root);
await mkdir(out, { recursive: true });
const summary: string[] = [];
try {
	for (const id of process.argv.slice(2)) {
		console.log(`${id}:`);
		const { spec } = validateSpec(await read(`examples/specs/${id}.md`), { surface });
		const example = JSON.parse(await read(`examples/builds/${id}.json`)) as Build;
		const { checks, log } = await writeChecks(spec!);
		await writeFile(new URL(`${id}.checks.json`, out), JSON.stringify({ checks, log }, null, '\t') + '\n');
		if (!checks) {
			summary.push(`✘ ${id}: no checks`);
			continue;
		}
		const { tree: _tree, code: _code, refs: _refs, provenance: _provenance, ...envelope } = example;
		const result = await compileA2UI({
			spec: spec!,
			surface,
			checks,
			envelope: { ...envelope, checks },
			model,
			verify: (build) => verifyA2UI(build, spec!, surface, sandbox),
			log: (line) => console.log(`  ${line}`),
		});
		if (result.build) {
			await writeFile(new URL(`${id}.a2ui.json`, out), JSON.stringify(result.build, null, '\t') + '\n');
		}
		// The example's tree build, against the fresh checks.
		const tree = await verifyBuild({ build: { ...example, checks }, spec: spec!, surface, sandbox, semantics, createCan, loadFunctions });
		const failing = tree.results.filter((r) => !r.passed);
		console.log(`  tree build against the fresh checks: ${tree.passed ? 'passes' : failing.map((r) => `${r.criterion}#${r.check + 1}: ${r.failures.join('; ')}`).join(' | ')}`);
		summary.push(
			`${result.ok ? '✔' : '✘'} ${id}: ${checks.length} checks; A2UI in ${result.attempts.length} attempt(s); tree build ${tree.passed ? 'passes them' : `fails ${failing.length}`}`,
		);
	}
} finally {
	await sandbox.close();
}
console.log(`\n${summary.join('\n')}`);
