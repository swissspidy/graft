import { readFile, writeFile } from 'node:fs/promises';
import { hashSpec, validateBuild, validateSpec, type Build, type Diagnostic } from '@swissspidy/graft-core';
import { loadHostFormats } from './hosts.ts';
import { loadSurface } from './validate.ts';

export interface BuildCommandOptions {
	surface: string;
	spec?: string;
	fixRefs?: boolean;
}

export interface BuildCommandResult {
	ok: boolean;
	diagnostics: Diagnostic[];
	fixed: boolean;
}

/**
 * Validates a build file against a surface and optionally its spec. With
 * fixRefs, recomputes the stored refs (and the spec and surface hashes)
 * and rewrites the file, which is how hand-written builds are maintained.
 */
export async function checkBuildFile(file: string, options: BuildCommandOptions): Promise<BuildCommandResult> {
	const surface = await loadSurface(options.surface);
	let build = JSON.parse(await readFile(file, 'utf8')) as Build;
	await loadHostFormats(surface.host);

	let spec: Parameters<typeof validateBuild>[2] = {};
	if (options.spec) {
		const source = await readFile(options.spec, 'utf8');
		const parsed = validateSpec(source, { surface });
		if (!parsed.spec) {
			return { ok: false, fixed: false, diagnostics: parsed.diagnostics };
		}
		spec = { spec: { spec: parsed.spec, hash: await hashSpec(source) } };
	}

	let result = await validateBuild(build, surface, spec);
	let fixed = false;
	if (options.fixRefs && result.refs) {
		build = {
			...build,
			spec: spec.spec ? { id: spec.spec.spec.manifest.id, hash: spec.spec.hash } : build.spec,
			surface: { host: surface.host, hostVersion: surface.hostVersion, hash: surface.hash ?? build.surface.hash },
			refs: result.refs,
		};
		await writeFile(file, JSON.stringify(build, null, '\t') + '\n');
		fixed = true;
		result = await validateBuild(build, surface, spec);
	}
	return { ok: result.ok, diagnostics: result.diagnostics, fixed };
}
