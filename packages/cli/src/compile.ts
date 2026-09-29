import { readFile, writeFile } from 'node:fs/promises';
import { compileSpec, hashSpec, validateSpec, type Build, type CompileEvent, type CompileResult, type ModelClient } from '@graft/core';
import { loadSurface } from './validate.ts';

export interface CompileCommandOptions {
	surface: string;
	out: string;
	model: ModelClient;
	/** Run each candidate's checks in a sandbox. Default true. */
	verify?: boolean;
	attempts?: number;
	/** A previous build of the same spec version whose checks are reused (and layout referenced). */
	previous?: string;
	log?(line: string): void;
}

function describe(event: CompileEvent): string {
	switch (event.type) {
		case 'request':
			return `→ ${event.purpose === 'checks' ? 'writing checks from the criteria' : 'building the tree'} (attempt ${event.attempt})`;
		case 'rejected':
			return `✖ ${event.purpose} attempt ${event.attempt} rejected:\n${event.problems.map((p) => `    ${p}`).join('\n')}`;
		case 'verified':
			return event.passed ? `✔ verification passed (attempt ${event.attempt})` : `✖ verification failed (attempt ${event.attempt})`;
	}
}

/**
 * Compiles a spec file into a build: checks from the criteria, then a tree
 * verified against them in a sandbox of the host, with retries. Writes the
 * build (accepted or last candidate) and, when verified, its verification.
 */
export async function compileFile(specFile: string, options: CompileCommandOptions): Promise<CompileResult> {
	const log = options.log ?? ((line: string) => console.error(line));
	const surface = await loadSurface(options.surface);
	const source = await readFile(specFile, 'utf8');
	const parsed = validateSpec(source, { surface });
	if (!parsed.spec) {
		throw new Error(`Invalid spec ${specFile}:\n${parsed.diagnostics.map((d) => `  ${d.line ?? ''} ${d.message}`).join('\n')}`);
	}
	const spec = parsed.spec;
	if (surface.host !== 'wordpress') {
		throw new Error(`No compiler support for host "${surface.host}".`);
	}
	const wordpress = await import('@graft/wordpress-adapter');

	const previous = options.previous ? (JSON.parse(await readFile(options.previous, 'utf8')) as Build) : undefined;
	const sandbox = options.verify === false ? undefined : await wordpress.startSandbox({ wp: surface.hostVersion.split('.').slice(0, 2).join('.') });
	try {
		const result = await compileSpec({
			spec,
			specHash: await hashSpec(source),
			surface,
			model: options.model,
			host: wordpress.hostGuide,
			maxAttempts: options.attempts ?? 3,
			...(previous ? { previous, checks: previous.checks } : {}),
			...(sandbox
				? { verify: async (build: Build) => (await wordpress.verifyInWordPress([{ build, spec, surface }], { sandbox }))[0]! }
				: {}),
			onEvent: (event) => log(describe(event)),
		});
		if (result.build) {
			await writeFile(options.out, JSON.stringify(result.build, null, '\t') + '\n');
			log(`${result.ok ? 'Wrote' : 'Wrote the last (failing) candidate to'} ${options.out}`);
		}
		if (result.verification) {
			const file = options.out.replace(/\.json$/, '') + '.verification.json';
			await writeFile(file, JSON.stringify(result.verification, null, '\t') + '\n');
		}
		return result;
	} finally {
		await sandbox?.close();
	}
}
