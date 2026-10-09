import { readFile, writeFile } from 'node:fs/promises';
import { createBundle, hashSpec, validateBuild, validateSpec, type Build, type CustomizationBundle, type Surface, type Verification } from '@graft/core';
import { hostTools, loadHostFormats } from './hosts.ts';
import { loadSurface } from './validate.ts';

export interface BundleOptions {
	spec: string;
	builds: string[];
	/** Surface files; each build is verified against the one with its hash. */
	surfaces: string[];
	out: string;
	verbose?: boolean;
}

export interface BundleResult {
	bundle?: CustomizationBundle;
	/** Why a build was left out, by file. */
	problems: string[];
}

/**
 * Writes a customization bundle: the spec with its parsed manifest, and each
 * build verified against its surface in a sandbox. Only builds that pass
 * go in, so whoever installs the bundle gets verified builds.
 */
export async function bundleFiles(options: BundleOptions): Promise<BundleResult> {
	const source = await readFile(options.spec, 'utf8');
	const surfaces = new Map<string, Surface>();
	for (const file of options.surfaces) {
		const surface = await loadSurface(file);
		surfaces.set(surface.hash!, surface);
	}
	const hash = await hashSpec(source);
	const problems: string[] = [];
	const builds: Array<{ build: Build; verification: Verification }> = [];
	let parsed: ReturnType<typeof validateSpec>['spec'];

	for (const file of options.builds) {
		const build = JSON.parse(await readFile(file, 'utf8')) as Build;
		const surface = surfaces.get(build.surface?.hash);
		if (!surface) {
			problems.push(`${file}: no surface given with hash ${build.surface?.hash}.`);
			continue;
		}
		const { spec, diagnostics } = validateSpec(source, { surface });
		if (!spec) {
			problems.push(`${options.spec}: ${diagnostics.map((d) => d.message).join(' ')}`);
			continue;
		}
		parsed = spec;
		if (build.spec?.hash !== hash) {
			problems.push(`${file}: built from another version of the spec.`);
			continue;
		}
		await loadHostFormats(surface.host);
		const errors = (await validateBuild(build, surface, { spec: { spec, hash } })).diagnostics.filter((d) => d.severity === 'error');
		if (errors.length > 0) {
			problems.push(`${file}: ${errors.map((d) => `${d.path ?? ''} ${d.message}`).join('; ')}`);
			continue;
		}
		const host = await hostTools(surface, { verbose: options.verbose ?? false });
		const [verification] = await host.verify([{ build, spec, surface }]);
		if (!verification?.passed) {
			const failed = verification?.results.filter((r) => !r.passed).map((r) => `${r.criterion}: ${r.failures.join(' ')}`) ?? [];
			problems.push(`${file}: checks fail (${failed.join('; ') || 'unchecked criteria'}).`);
			continue;
		}
		builds.push({ build, verification });
	}

	if (!parsed || builds.length === 0) {
		return { problems: [...problems, 'No verified build: nothing written.'] };
	}
	const bundle = await createBundle(source, parsed, builds);
	await writeFile(options.out, JSON.stringify(bundle, null, '\t') + '\n');
	return { bundle, problems };
}
