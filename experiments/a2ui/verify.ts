import { readdir, readFile } from 'node:fs/promises';
import { hashSpec, validateSpec, verifyBuild, type Build, type Spec, type Surface, type Verification } from '../../packages/core/src/index.ts';
import { createCan } from '../../hosts/wordpress/adapter/src/can.ts';
import { startSandbox } from '../../hosts/wordpress/adapter/src/sandbox.ts';
import { semantics } from '../../hosts/wordpress/adapter/src/semantics.ts';
import { snapshotA2UI, type A2UIBuild } from './snapshot.ts';

/**
 * Runs review-queue's unchanged checks in a WordPress sandbox against the
 * build as a Graft tree, as an A2UI surface, and two broken A2UI variants.
 */

const root = new URL('../../', import.meta.url);
const read = async (path: string) => readFile(new URL(path, root), 'utf8');

const surface = JSON.parse(await read('hosts/wordpress/plugin/surfaces/7.1.json')) as Surface;
const source = await read('examples/specs/review-queue.md');
const { spec } = validateSpec(source, { surface });
if (!spec || (await hashSpec(source)) === '') {
	throw new Error('review-queue spec is invalid');
}
const tree = JSON.parse(await read('examples/builds/review-queue.json')) as Build;
const a2ui = JSON.parse(await read('experiments/a2ui/review-queue.a2ui.json')) as A2UIBuild;

// Broken on purpose: the checks must catch both.
const showsApproveToEveryone = structuredClone(a2ui);
const table = showsApproveToEveryone.ui.components.find((c) => c.id === 'queue') as unknown as { rowActions: Array<{ visible?: unknown }> };
delete table.rowActions[0]!.visible;
const approvesToDraft = structuredClone(a2ui);
approvesToDraft.events.approve!.input = { id: { $context: 'id' }, status: 'draft' };

const sandbox = await startSandbox({});
const verify = (build: Build | A2UIBuild, ui?: 'a2ui'): Promise<Verification> =>
	verifyBuild({
		build: build as Build,
		spec: spec as Spec,
		surface,
		sandbox,
		semantics,
		createCan,
		...(ui ? { snapshot: (b: Build, ctx, entered) => snapshotA2UI(b as unknown as A2UIBuild, ctx, entered) } : {}),
	});

const report = (name: string, verification: Verification) => {
	console.log(`\n${verification.passed ? '✔' : '✘'} ${name}`);
	for (const result of verification.results) {
		console.log(`  ${result.passed ? '✔' : '✘'} ${result.criterion}${result.failures.length ? `: ${result.failures.join('; ')}` : ''}`);
	}
};

try {
	report('Graft tree (examples/builds/review-queue.json)', await verify(tree));
	report('A2UI surface (experiments/a2ui/review-queue.a2ui.json)', await verify(a2ui, 'a2ui'));
	report('A2UI, broken: Approve shown to everyone', await verify(showsApproveToEveryone, 'a2ui'));
	report('A2UI, broken: Approve sets status to draft', await verify(approvesToDraft, 'a2ui'));
	// Every compiled build, against its own spec's frozen checks.
	for (const file of (await readdir(new URL('experiments/a2ui/compiled/', root))).filter((f) => f.endsWith('.a2ui.json')).sort()) {
		const id = file.replace(/\.a2ui\.json$/, '');
		const compiled = JSON.parse(await read(`experiments/a2ui/compiled/${file}`)) as A2UIBuild;
		const own = validateSpec(await read(`examples/specs/${id}.md`), { surface }).spec as Spec;
		report(`Compiled: ${id}`, await verifyBuild({ build: compiled as unknown as Build, spec: own, surface, sandbox, semantics, createCan, snapshot: (b, ctx, entered) => snapshotA2UI(b as unknown as A2UIBuild, ctx, entered) }));
	}
} finally {
	await sandbox.close();
}
