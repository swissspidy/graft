import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashSpec, validateBuild, validateSpec, type Build, type Spec, type Surface, type Verification } from '@swissspidy/graft-core';
import { hostTools, loadHostFormats } from './hosts.ts';
import { displayPath, formatSpecLocation } from './format.ts';
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
	/** The spec file the build was matched with, and the line of each of its criteria. */
	spec?: { file: string; criteria: Record<string, number> };
}

/** Valid specs in a file or directory, by id, with their hash and file. */
async function loadSpecs(path: string, surface: Surface): Promise<Map<string, { spec: Spec; hash: string; file: string }>> {
	const files = path.endsWith('.md') ? [path] : (await readdir(path)).filter((f) => f.endsWith('.md')).map((f) => join(path, f));
	const specs = new Map<string, { spec: Spec; hash: string; file: string }>();
	for (const file of files) {
		const source = await readFile(file, 'utf8');
		const { spec } = validateSpec(source, { surface });
		if (spec) {
			specs.set(spec.manifest.id, { spec, hash: await hashSpec(source), file });
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
	const targets: Array<{ file: string; build: Build; spec: Spec; specFile: string }> = [];

	await loadHostFormats(surface.host);
	for (const file of files) {
		const build = JSON.parse(await readFile(file, 'utf8')) as Build;
		const spec = specs.get(build.spec?.id);
		if (!spec) {
			results.push({ file, errors: [`No valid spec with id "${build.spec?.id}" in ${options.spec}.`] });
			continue;
		}
		const validation = await validateBuild(build, surface, { spec });
		const errors = validation.diagnostics.filter((d) => d.severity === 'error').map((d) => {
			const where = formatSpecLocation(d.spec, spec.file);
			return `${d.path ?? ''} ${d.message}${where ? `  → ${where}` : ''}`;
		});
		if (errors.length > 0) {
			results.push({ file, errors, spec: specLines(spec) });
			continue;
		}
		targets.push({ file, build, spec: spec.spec, specFile: spec.file });
	}

	if (targets.length > 0) {
		const host = await hostTools(surface, { ...(options.wp ? { wp: options.wp } : {}), verbose: options.verbose ?? false });
		const verifications = await host.verify(targets.map(({ build, spec }) => ({ build, spec, surface })));
		targets.forEach(({ file, spec, specFile }, i) => results.push({ file, verification: verifications[i]!, errors: [], spec: specLines({ spec, file: specFile }) }));
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

/** The spec file and the line of each of its criteria, for pointing at them in output. */
function specLines({ spec, file }: { spec: Spec; file: string }): { file: string; criteria: Record<string, number> } {
	return { file, criteria: Object.fromEntries(spec.criteria.map((c) => [c.id, c.line])) };
}

/** Verification results as text: each build, its checks by criterion, and the spec line of each that failed or has no check. */
export function formatVerification(results: VerifyCommandResult[]): string {
	const out: string[] = [];
	for (const { file, verification, errors, spec } of results) {
		// Each criterion with the spec line that states it, for an editor to jump to.
		const at = (id: string) => {
			const line = spec?.criteria[id];
			return spec && line !== undefined ? `  (${displayPath(spec.file)}:${line})` : '';
		};
		if (!verification) {
			out.push(`✖ ${file}  not verified`);
			errors.forEach((e) => out.push(`    ${e}`));
			continue;
		}
		const passed = verification.results.filter((r) => r.passed).length;
		out.push(`${verification.passed ? '✔' : '✖'} ${verification.spec.id}  ${passed}/${verification.results.length} checks passed  (${file})`);
		for (const result of verification.results) {
			out.push(`  ${result.passed ? '✔' : '✖'} ${result.criterion}${result.passed ? '' : at(result.criterion)}`);
			result.failures.forEach((f) => out.push(`      ${f}`));
		}
		verification.unchecked.forEach((id) => out.push(`  ✖ ${id}  (no check)${at(id)}`));
	}
	return out.join('\n');
}
