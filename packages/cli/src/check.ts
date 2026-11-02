import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, hasErrors, hashSpec, hashSurface, validateBuild, validateSpec, validateSurface, type Diagnostic, type Spec, type Surface } from '@swissspidy/graft-core';
import { formatSpecLocation } from './format.ts';
import { loadHostFormats } from './hosts.ts';
import { loadSurface } from './validate.ts';

export interface CheckCommandOptions {
	/** Surface files to check builds against, besides the surfaces found under the paths. */
	surfaces?: string[];
}

export interface CheckFileResult {
	file: string;
	kind: 'spec' | 'build' | 'bundle' | 'surface';
	ok: boolean;
	/** For a build or a bundle: the spec file it was checked against. */
	spec?: string;
	diagnostics: Diagnostic[];
}

export interface CheckCommandResult {
	ok: boolean;
	files: CheckFileResult[];
	surfaces: string[];
}

/** A Markdown file is a spec when its frontmatter has a `graft` key; other Markdown is documentation. */
const SPEC_FRONTMATTER = /^\uFEFF?---\r?\n(?:(?!---\r?\n).*\r?\n)*?graft:/;

const SKIP_DIRS = new Set(['node_modules', 'test-results', 'dist']);

/** Every file under the paths (recursively), skipping dependencies, outputs and dot directories. */
async function collectFiles(paths: string[]): Promise<string[]> {
	const files: string[] = [];
	const walk = async (dir: string) => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
					await walk(path);
				}
			} else if (entry.isFile()) {
				files.push(path);
			}
		}
	};
	for (const path of paths) {
		if ((await stat(path)).isDirectory()) {
			await walk(path);
		} else {
			files.push(path);
		}
	}
	return [...new Set(files.map((f) => resolve(f)))].sort();
}

type JsonKind = { kind: 'build' | 'bundle'; value: Record<string, unknown> } | { kind: 'surface'; value: unknown } | undefined;

/**
 * What a JSON file is. Every `graft` document is a customization bundle,
 * a surface (a host with slots and capabilities) or else a build, which
 * validation then judges, so a build missing a field is reported rather
 * than skipped. Other JSON (schemas, package files, verification records)
 * is left alone.
 */
function classifyJson(value: unknown): JsonKind {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (!('graft' in record)) {
		return undefined;
	}
	if (record.kind === 'customization') {
		return { kind: 'bundle', value: record };
	}
	if (typeof record.host === 'string' && 'slots' in record && 'capabilities' in record) {
		return { kind: 'surface', value };
	}
	return { kind: 'build', value: record };
}

/** Number of leading directory segments two files share. */
function sharedDepth(a: string, b: string): number {
	const left = dirname(a).split(sep);
	const right = dirname(b).split(sep);
	let depth = 0;
	while (depth < left.length && depth < right.length && left[depth] === right[depth]) {
		depth++;
	}
	return depth;
}

/**
 * Checks, without a sandbox, that every build under the paths is up to date
 * with what it was made from: the spec it claims (same id on the same host,
 * the nearest one by directory), at the version it claims (spec hash), and
 * a surface it claims (host and hash). Each build is also validated in
 * full against them, so refs that no longer match the content (a build
 * edited by hand) and criteria without checks are reported too. Specs
 * under the paths are validated on the way.
 */
export async function checkFiles(paths: string[], options: CheckCommandOptions = {}): Promise<CheckCommandResult> {
	const files: CheckFileResult[] = [];
	const specs: Array<{ file: string; spec: Spec; hash: string }> = [];
	const builds: Array<{ file: string; value: Record<string, unknown> }> = [];
	const bundles: Array<{ file: string; value: Record<string, unknown> }> = [];
	const surfaces: Array<{ file: string; surface: Surface; hash: string }> = [];

	const addSurface = async (file: string, surface: Surface) => {
		surfaces.push({ file, surface, hash: surface.hash ?? (await hashSurface(surface)) });
	};
	for (const file of options.surfaces ?? []) {
		await addSurface(resolve(file), await loadSurface(file));
	}

	for (const file of await collectFiles(paths)) {
		if (file.endsWith('.md')) {
			const source = await readFile(file, 'utf8');
			if (!SPEC_FRONTMATTER.test(source)) {
				continue; // Documentation, not a spec.
			}
			const result = validateSpec(source);
			files.push({ file, kind: 'spec', ok: result.ok, diagnostics: result.diagnostics });
			if (result.spec) {
				specs.push({ file, spec: result.spec, hash: await hashSpec(source) });
			}
		} else if (file.endsWith('.json')) {
			const fail = (code: string, message: string) => files.push({ file, kind: 'build', ok: false, diagnostics: [{ severity: 'error', code, path: '/', message }] });
			const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
			let text: string;
			try {
				text = await readFile(file, 'utf8');
			} catch (error) {
				fail('check-read', `Could not read the file: ${reason(error)}`);
				continue;
			}
			let value: unknown;
			try {
				value = JSON.parse(text);
			} catch (error) {
				// A build or bundle that does not parse must not pass for being skipped; other JSON
				// (a tsconfig.json with comments) is not ours to judge.
				if (/"graft"\s*:/.test(text)) {
					fail('check-json', `Not valid JSON: ${reason(error)}`);
				}
				continue;
			}
			const kind = classifyJson(value);
			if (kind?.kind === 'build') {
				builds.push({ file, value: kind.value });
			} else if (kind?.kind === 'bundle') {
				bundles.push({ file, value: kind.value });
			} else if (kind?.kind === 'surface' && !surfaces.some((s) => s.file === file)) {
				const result = await validateSurface(kind.value);
				if (result.surface) {
					await addSurface(file, result.surface);
				} else {
					files.push({ file, kind: 'surface', ok: false, diagnostics: result.diagnostics });
				}
			}
		}
	}

	const nearestSpec = (file: string, id: unknown, host: unknown) => {
		const candidates = specs.filter((s) => s.spec.manifest.id === id && s.spec.manifest.host === host);
		const nearest = Math.max(-1, ...candidates.map((s) => sharedDepth(s.file, file)));
		const closest = candidates.filter((s) => sharedDepth(s.file, file) === nearest);
		return { candidates, closest, spec: closest.length === 1 ? closest[0] : undefined };
	};

	/**
	 * Checks one build against a surface here and a spec: the spec file nearest to it, or the
	 * spec a bundle carries. Diagnostics point into the file, under `base`.
	 */
	const checkBuild = async (file: string, base: string, value: Record<string, unknown>, carried?: { spec: Spec; hash: string }) => {
		const claimed = value as { spec?: { id?: unknown; hash?: unknown }; surface?: { host?: unknown; hash?: unknown } };
		const id = claimed.spec?.id;
		const host = claimed.surface?.host;
		const diagnostics: Diagnostic[] = [];
		const error = (code: string, path: string, message: string) => diagnostics.push({ severity: 'error', code, path: base + path, message });
		if (typeof id !== 'string' || typeof host !== 'string') {
			error('check-build-shape', '/', 'A build needs spec.id and surface.host to be checked at all.');
			return { diagnostics, spec: undefined };
		}

		const ofHost = surfaces.filter((s) => s.surface.host === host);
		const surface = ofHost.find((s) => s.hash === claimed.surface?.hash);
		if (!surface) {
			const known = ofHost.map((s) => `${s.surface.hostVersion} ${s.hash}`).join(', ');
			error(
				'check-surface-stale',
				'/surface',
				ofHost.length > 0
					? `The build targets ${String(host)} surface ${String(claimed.surface?.hash)}, which no surface here has (${known}). Upgrade or rebuild it for the current surface.`
					: `No ${String(host)} surface to check the build against. Pass one with --surface.`,
			);
		}

		let spec: { file?: string; spec: Spec; hash: string } | undefined = carried;
		if (!carried) {
			const found = nearestSpec(file, id, host);
			spec = found.spec;
			if (found.candidates.length === 0) {
				error('check-spec-missing', '/spec/id', `No ${String(host)} spec with id "${String(id)}" under the paths.`);
			} else if (!spec) {
				error('check-spec-ambiguous', '/spec/id', `More than one spec with id "${String(id)}" is as near: ${found.closest.map((s) => s.file).join(', ')}.`);
			}
		}
		if (spec && claimed.spec?.hash !== spec.hash) {
			error(
				'check-spec-stale',
				'/spec/hash',
				carried
					? `The build implements ${String(id)} ${String(claimed.spec?.hash)}, not the spec in this bundle (${spec.hash}).`
					: `The build implements ${String(id)} ${String(claimed.spec?.hash)}, but the spec is now ${spec.hash}. Compile it again from the spec (graft compile).`,
			);
		}

		if (surface) {
			await loadHostFormats(surface.surface.host);
			// A stale spec hash is reported above, once, in words that say what to do; the rest of
			// the spec (mount, permissions, criteria) is still checked against the spec as it is now.
			const validation = await validateBuild(value, surface.surface, spec ? { spec: { spec: spec.spec, hash: String(claimed.spec?.hash) } } : {});
			diagnostics.push(...validation.diagnostics.map((d) => ({ ...d, path: base + (d.path ?? '') })));
		}
		return { diagnostics, spec: spec?.file };
	};

	for (const { file, value } of builds) {
		const { diagnostics, spec } = await checkBuild(file, '', value);
		files.push({ file, kind: 'build', ok: !hasErrors(diagnostics), ...(spec ? { spec } : {}), diagnostics });
	}

	// A bundle carries its spec and verified builds: they must agree with each other, and the
	// spec must still be the one next to it on disk, or the bundle ships an old version.
	for (const { file, value } of bundles) {
		const bundle = value as { spec?: { source?: unknown; manifest?: unknown; hash?: unknown }; builds?: unknown };
		const diagnostics: Diagnostic[] = [];
		const error = (code: string, path: string, message: string) => diagnostics.push({ severity: 'error', code, path, message });
		let against: string | undefined;
		if (typeof bundle.spec?.source !== 'string' || !Array.isArray(bundle.builds) || bundle.builds.length === 0) {
			error('check-bundle-shape', '/', 'A bundle needs spec.source and at least one build.');
			files.push({ file, kind: 'bundle', ok: false, diagnostics });
			continue;
		}
		const source = bundle.spec.source;
		const parsed = validateSpec(source);
		diagnostics.push(...parsed.diagnostics.map((d) => ({ ...d, path: `/spec/source${d.path ?? ''}` })));
		const hash = await hashSpec(source);
		if (bundle.spec.hash !== hash) {
			error('check-bundle-spec-hash', '/spec/hash', `The bundle's spec hash is ${String(bundle.spec.hash)}, but its source hashes to ${hash}.`);
		}
		if (parsed.spec) {
			if (canonicalJson(bundle.spec.manifest) !== canonicalJson(parsed.spec.manifest)) {
				error('check-bundle-manifest', '/spec/manifest', "The bundle's manifest is not the one its spec source declares.");
			}
			const found = nearestSpec(file, parsed.spec.manifest.id, parsed.spec.manifest.host);
			const onDisk = found.spec;
			if (!onDisk && found.closest.length > 1) {
				error('check-spec-ambiguous', '/spec/source', `More than one spec with id "${parsed.spec.manifest.id}" is as near: ${found.closest.map((s) => s.file).join(', ')}.`);
			}
			if (onDisk) {
				against = onDisk.file;
				if (onDisk.hash !== hash) {
					error('check-bundle-stale', '/spec/source', `The bundle carries ${parsed.spec.manifest.id} ${hash}, but the spec is now ${onDisk.hash}. Bundle it again (graft bundle).`);
				}
			}
			const carried = { spec: parsed.spec, hash };
			for (const [i, entry] of (bundle.builds as Array<{ build?: unknown; verification?: unknown }>).entries()) {
				const base = `/builds/${i}`;
				const build = entry?.build;
				if (classifyJson(build)?.kind !== 'build') {
					error('check-bundle-shape', `${base}/build`, 'Not a build.');
					continue;
				}
				diagnostics.push(...(await checkBuild(file, `${base}/build`, build as Record<string, unknown>, carried)).diagnostics);
				const claimed = build as { spec?: unknown; surface?: { hash?: unknown } | null; checks?: Array<{ criterion?: unknown }> };
				const verification = entry.verification as
					| { passed?: unknown; spec?: unknown; surface?: { hash?: unknown }; results?: Array<{ passed?: unknown; check?: unknown; criterion?: unknown }>; unchecked?: unknown[] }
					| undefined;
				// Passed as the verifier decides it: one passing result for each of the build's checks,
				// in order, and no criterion unchecked.
				const checks = Array.isArray(claimed.checks) ? claimed.checks : [];
				const passed =
					verification?.passed === true &&
					Array.isArray(verification.results) &&
					verification.results.length > 0 &&
					verification.results.length === checks.length &&
					verification.results.every((r, i) => r?.passed === true && r.check === i && r.criterion === checks[i]?.criterion) &&
					Array.isArray(verification.unchecked) &&
					verification.unchecked.length === 0;
				if (!passed || canonicalJson(verification?.spec) !== canonicalJson(claimed.spec) || verification?.surface?.hash !== claimed.surface?.hash) {
					error('check-bundle-verification', `${base}/verification`, 'The build has no passing verification for its spec and surface. Bundle it again (graft bundle).');
				}
			}
		}
		files.push({ file, kind: 'bundle', ok: !hasErrors(diagnostics), ...(against ? { spec: against } : {}), diagnostics });
	}

	files.sort((a, b) => a.file.localeCompare(b.file));
	return { ok: files.every((f) => f.ok), files, surfaces: surfaces.map((s) => s.file) };
}

export function formatCheck(result: CheckCommandResult, cwd: string): string {
	const name = (file: string) => {
		const rel = relative(cwd, file);
		return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file;
	};
	const out: string[] = [];
	for (const file of result.files) {
		const against = file.spec ? `  ← ${name(file.spec)}` : '';
		out.push(`${file.ok ? '✔' : '✖'} ${name(file.file)}${against}`);
		for (const d of file.diagnostics) {
			const where = d.line !== undefined ? `:${d.line}` : d.path ? `  ${d.path}` : '';
			const spec = formatSpecLocation(d.spec, file.spec);
			out.push(`  ${d.severity.padEnd(7)}${where}  ${d.message}  [${d.code}]${spec ? `  → ${spec}` : ''}`);
		}
	}
	const count = (kind: CheckFileResult['kind']) => result.files.filter((f) => f.kind === kind).length;
	const failed = result.files.filter((f) => !f.ok).length;
	out.push('', `${count('build')} build(s), ${count('bundle')} bundle(s), ${count('spec')} spec(s), ${result.surfaces.length} surface(s): ${failed === 0 ? 'all up to date' : `${failed} with errors`}`);
	return out.join('\n');
}
