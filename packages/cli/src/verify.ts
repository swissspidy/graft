import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashSpec, validateBuild, validateSpec, type Build, type Spec, type Surface, type Verification } from '@graft/core';
import { loadSurface } from './validate.ts';

export interface VerifyCommandOptions {
	surface: string;
	/** A spec file, or a directory of specs matched to builds by id. */
	spec: string;
	out?: string;
	wp?: string;
	verbose?: boolean;
}

export interface VerifyCommandResult {
	file: string;
	/** Present when the build could be verified at all. */
	verification?: Verification;
	/** Why it could not be verified. */
	errors: string[];
}

async function loadSpecs(path: string, surface: Surface): Promise<Map<string, { spec: Spec; hash: string }>> {
	const files = path.endsWith('.md') ? [path] : (await readdir(path)).filter((f) => f.endsWith('.md')).map((f) => join(path, f));
	const specs = new Map<string, { spec: Spec; hash: string }>();
	for (const file of files) {
		const source = await readFile(file, 'utf8');
		const { spec } = validateSpec(source, { surface });
		if (spec) {
			specs.set(spec.manifest.id, { spec, hash: await hashSpec(source) });
		}
	}
	return specs;
}

/**
 * Verifies build files in a sandbox of their host: every check runs against
 * synthetic fixtures through real capability calls. Builds that are not
 * valid for the surface and spec are not run.
 */
export async function verifyFiles(files: string[], options: VerifyCommandOptions): Promise<VerifyCommandResult[]> {
	const surface = await loadSurface(options.surface);
	const specs = await loadSpecs(options.spec, surface);
	const results: VerifyCommandResult[] = [];
	const targets: Array<{ file: string; build: Build; spec: Spec }> = [];

	for (const file of files) {
		const build = JSON.parse(await readFile(file, 'utf8')) as Build;
		const spec = specs.get(build.spec?.id);
		if (!spec) {
			results.push({ file, errors: [`No valid spec with id "${build.spec?.id}" in ${options.spec}.`] });
			continue;
		}
		const validation = await validateBuild(build, surface, { spec });
		const errors = validation.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.path ?? ''} ${d.message}`);
		if (errors.length > 0) {
			results.push({ file, errors });
			continue;
		}
		targets.push({ file, build, spec: spec.spec });
	}

	if (targets.length > 0) {
		if (surface.host !== 'wordpress') {
			throw new Error(`No sandbox for host "${surface.host}".`);
		}
		const { playgroundVersion, verifyInWordPress } = await import('@graft/wordpress-adapter');
		const verifications = await verifyInWordPress(
			targets.map(({ build, spec }) => ({ build, spec, surface })),
			{ wp: options.wp ?? playgroundVersion(surface.hostVersion), verbose: options.verbose ?? false },
		);
		targets.forEach(({ file }, i) => results.push({ file, verification: verifications[i]!, errors: [] }));
	}

	if (options.out) {
		await mkdir(options.out, { recursive: true });
		for (const result of results) {
			if (result.verification) {
				await writeFile(join(options.out, `${result.verification.spec.id}.json`), JSON.stringify(result.verification, null, '\t') + '\n');
			}
		}
	}
	return results;
}

export function formatVerification(results: VerifyCommandResult[]): string {
	const out: string[] = [];
	for (const { file, verification, errors } of results) {
		if (!verification) {
			out.push(`✖ ${file}  not verified`);
			errors.forEach((e) => out.push(`    ${e}`));
			continue;
		}
		const passed = verification.results.filter((r) => r.passed).length;
		out.push(`${verification.passed ? '✔' : '✖'} ${verification.spec.id}  ${passed}/${verification.results.length} checks passed  (${file})`);
		for (const result of verification.results) {
			out.push(`  ${result.passed ? '✔' : '✖'} ${result.criterion}`);
			result.failures.forEach((f) => out.push(`      ${f}`));
		}
		verification.unchecked.forEach((id) => out.push(`  ✖ ${id}  (no check)`));
	}
	return out.join('\n');
}
