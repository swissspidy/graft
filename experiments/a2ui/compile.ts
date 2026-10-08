import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { validateSpec, verifyBuild, type Build, type Spec, type Surface } from '../../packages/core/src/index.ts';
import { anthropicModel } from '../../packages/cli/src/anthropic.ts';
import { createCan } from '../../hosts/wordpress/adapter/src/can.ts';
import { startSandbox, type WordPressSandbox } from '../../hosts/wordpress/adapter/src/sandbox.ts';
import { semantics } from '../../hosts/wordpress/adapter/src/semantics.ts';
import { compileA2UI } from './compiler.ts';
import { snapshotA2UI, type A2UIBuild } from './snapshot.ts';

/**
 * Compiles specs to A2UI builds with Claude against the frozen checks of
 * their example builds, verifying each candidate in a WordPress sandbox and
 * sending failures back, as the Graft compiler's tree phase does.
 *
 *   ANTHROPIC_API_KEY=... npx tsx experiments/a2ui/compile.ts review-queue publish-checklist
 *
 * Builds go to experiments/a2ui/compiled/, with a log of every attempt.
 */

const root = new URL('../../', import.meta.url);
const read = async (path: string) => readFile(new URL(path, root), 'utf8');

/** Verifies an A2UI build in a sandbox, optionally simulating another grant. */
export const verifyA2UI = (build: A2UIBuild, spec: Spec, surface: Surface, sandbox: WordPressSandbox, grant?: string[]) =>
	verifyBuild({
		build: build as unknown as Build,
		spec,
		surface,
		sandbox,
		semantics,
		createCan,
		...(grant ? { grant } : {}),
		snapshot: (b, ctx, entered) => snapshotA2UI(b as unknown as A2UIBuild, ctx, entered),
	});

if (import.meta.url === `file://${process.argv[1]}`) {
	const surface = JSON.parse(await read('hosts/wordpress/plugin/surfaces/7.1.json')) as Surface;
	const model = anthropicModel({ effort: (process.env.EFFORT as 'high') ?? 'high' });
	await mkdir(new URL('experiments/a2ui/compiled/', root), { recursive: true });
	const sandbox = await startSandbox({});
	const summary: string[] = [];
	try {
		for (const id of process.argv.slice(2)) {
			const { spec } = validateSpec(await read(`examples/specs/${id}.md`), { surface });
			if (!spec) {
				throw new Error(`${id}: invalid spec`);
			}
			const { tree: _tree, code: _code, refs: _refs, provenance: _provenance, ...envelope } = JSON.parse(await read(`examples/builds/${id}.json`)) as Build;
			const result = await compileA2UI({
				spec,
				surface,
				checks: envelope.checks,
				envelope,
				model,
				maxAttempts: Number(process.env.ATTEMPTS ?? 3),
				verify: (build) => verifyA2UI(build, spec, surface, sandbox),
				log: (line) => console.log(`${id}: ${line}`),
			});
			if (result.build) {
				await writeFile(new URL(`experiments/a2ui/compiled/${id}.a2ui.json`, root), JSON.stringify(result.build, null, '\t') + '\n');
			}
			await writeFile(new URL(`experiments/a2ui/compiled/${id}.log.json`, root), JSON.stringify(result.attempts, null, '\t') + '\n');
			summary.push(`${result.ok ? '✔' : '✘'} ${id}: ${result.attempts.length} attempt(s)`);
		}
	} finally {
		await sandbox.close();
	}
	console.log(`\n${summary.join('\n')}`);
}
