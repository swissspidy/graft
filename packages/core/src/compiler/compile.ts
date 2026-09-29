import buildSchema from '../../../../schemas/build.schema.json' with { type: 'json' };
import '../ajv.ts';
import { describeSchemaError } from '../schema-errors.ts';
import { lazyValidator, type Validator } from '../schema.ts';
import { extractRefs } from '../build/refs.ts';
import type { Build, Check } from '../build/types.ts';
import { validateBuild } from '../build/validate.ts';
import { canonicalJson, sha256 } from '../surface/hash.ts';
import { assembleChecks, assembleTree, assembleUnverifiable } from './assemble.ts';
import { checksPrompt, checksSystem, treePrompt, treeSystem } from './prompt.ts';
import { checksOutputSchema, treeOutputSchema } from './schemas.ts';
import type { CompileAttempt, CompileOptions, CompileResult } from './types.ts';

export const COMPILER_VERSION = 'graft-compiler/0.1.0';

// The check definition, with the definitions it refers to.
const validateCheck: Validator = lazyValidator({ $defs: buildSchema.$defs, $ref: '#/$defs/check' });

/**
 * Compiles a spec into a build for one surface, in two phases:
 *
 * 1. Checks: the model turns the acceptance criteria into executable checks,
 *    without seeing any implementation. They are then frozen (or passed in
 *    from an earlier build of the same spec version).
 * 2. Tree: the model builds the tree and data sources against the frozen
 *    checks. Each candidate is assembled, validated against the surface and
 *    spec, and verified; problems go back to the model until it passes or
 *    the attempts run out.
 *
 * The model never sees or edits the checks it is graded by after phase 1.
 */
export async function compileSpec(options: CompileOptions): Promise<CompileResult> {
	const { spec, surface, model, host } = options;
	const maxAttempts = options.maxAttempts ?? 3;
	const attempts: CompileAttempt[] = [];

	// Phase 1: checks.
	let checks = options.checks;
	if (!checks) {
		const system = checksSystem(spec, surface, host);
		const schema = checksOutputSchema(spec);
		let feedback: string[] = [];
		for (let attempt = 1; attempt <= maxAttempts && !checks; attempt++) {
			options.onEvent?.({ type: 'request', purpose: 'checks', attempt });
			const response = await model.generate({ purpose: 'checks', system, prompt: checksPrompt(spec, feedback), schema });
			const unverifiable = assembleUnverifiable(response.output);
			if (unverifiable.length > 0) {
				const problems = unverifiable.map((u) => `Criterion "${u.criterion}" cannot be checked: ${u.reason}`);
				attempts.push({ phase: 'checks', problems, diagnostics: [] });
				options.onEvent?.({ type: 'rejected', purpose: 'checks', attempt, problems });
				return { ok: false, unverifiable, attempts };
			}
			const assembled = assembleChecks(response.output);
			const problems = [...assembled.problems];
			if (assembled.value) {
				problems.push(...checkProblems(assembled.value, spec.criteria.map((c) => c.id)));
			}
			attempts.push({ phase: 'checks', problems, diagnostics: [] });
			if (problems.length === 0) {
				checks = assembled.value;
			} else {
				options.onEvent?.({ type: 'rejected', purpose: 'checks', attempt, problems });
				feedback = problems;
			}
		}
		if (!checks) {
			return { ok: false, attempts };
		}
	}

	// Phase 2: tree and data against the frozen checks.
	const system = treeSystem(spec, surface, host);
	const schema = treeOutputSchema(spec, surface);
	const surfaceHash = surface.hash ?? '';
	let feedback: string[] = [];
	let candidate: Build | undefined;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		options.onEvent?.({ type: 'request', purpose: 'tree', attempt });
		const prompt = treePrompt(spec, checks, options.previous, feedback);
		const response = await model.generate({ purpose: 'tree', system, prompt, schema });
		const assembled = assembleTree(response.output);
		if (!assembled.value) {
			attempts.push({ phase: 'tree', problems: assembled.problems, diagnostics: [] });
			options.onEvent?.({ type: 'rejected', purpose: 'tree', attempt, problems: assembled.problems });
			feedback = assembled.problems;
			continue;
		}

		const provenance: Build['provenance'] = {
			compiler: options.compilerVersion ?? COMPILER_VERSION,
			model: response.model,
			promptHash: `sha256:${await sha256(system + '\n\n' + prompt)}`,
			strategy: options.previous ? 'regenerated' : 'compiled',
		};
		if (options.previous) {
			provenance.replaces = await buildHash(options.previous);
		}
		candidate = {
			graft: 1,
			spec: { id: spec.manifest.id, hash: options.specHash },
			surface: { host: surface.host, hostVersion: surface.hostVersion, hash: surfaceHash },
			mount: spec.manifest.mount,
			tree: assembled.value.tree,
			data: assembled.value.data,
			checks,
			refs: { slot: spec.manifest.mount.slot, components: {}, capabilities: [], scopes: [] },
			provenance,
		};
		candidate.refs = extractRefs(candidate, surface);

		const validation = await validateBuild(candidate, surface, { spec: { spec, hash: options.specHash } });
		const errors = validation.diagnostics.filter((d) => d.severity === 'error');
		if (errors.length > 0) {
			const problems = errors.map((d) => `${d.path ?? ''}: ${d.message}`);
			attempts.push({ phase: 'tree', problems, diagnostics: validation.diagnostics });
			options.onEvent?.({ type: 'rejected', purpose: 'tree', attempt, problems });
			feedback = problems;
			continue;
		}

		if (!options.verify) {
			attempts.push({ phase: 'tree', problems: [], diagnostics: validation.diagnostics });
			return { ok: true, build: candidate, checks, attempts };
		}
		const verification = await options.verify(candidate);
		options.onEvent?.({ type: 'verified', attempt, passed: verification.passed });
		const problems = [
			...verification.results.filter((r) => !r.passed).flatMap((r) => r.failures.map((f) => `Check for "${r.criterion}": ${f}`)),
			...verification.unchecked.map((id) => `Criterion "${id}" has no check.`),
		];
		attempts.push({ phase: 'tree', problems, diagnostics: validation.diagnostics, verification });
		if (verification.passed) {
			return { ok: true, build: candidate, checks, verification, attempts };
		}
		options.onEvent?.({ type: 'rejected', purpose: 'tree', attempt, problems });
		feedback = problems;
	}

	const result: CompileResult = { ok: false, checks, attempts };
	if (candidate) {
		result.build = candidate;
	}
	const last = attempts.at(-1)?.verification;
	if (last) {
		result.verification = last;
	}
	return result;
}

function checkProblems(checks: Check[], criteria: string[]): string[] {
	const problems: string[] = [];
	checks.forEach((check, i) => {
		if (!validateCheck(check)) {
			problems.push(`Check ${i + 1} (${check.criterion}) is malformed: ${(validateCheck.errors ?? []).map((e) => describeSchemaError(e, '', 'the check')).join(' ')}.`);
		}
	});
	for (const id of criteria) {
		if (!checks.some((check) => check.criterion === id)) {
			problems.push(`Criterion "${id}" has no check.`);
		}
	}
	return problems;
}

/** Content hash of a build, for provenance. */
export async function buildHash(build: Build): Promise<string> {
	return `sha256:${await sha256(canonicalJson(build))}`;
}
