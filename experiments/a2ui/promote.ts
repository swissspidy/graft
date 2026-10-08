import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extractRefs, hashSpec, validateBuild, validateSpec, type Build, type Surface } from '../../packages/core/src/index.ts';
import '../../hosts/wordpress/adapter/src/a2ui.ts';

/**
 * Turns the builds compiled in experiments/a2ui/compiled into the A2UI
 * example corpus (examples/a2ui/builds): the example build's envelope, the
 * compiled UI on the `graft:wordpress` catalog, refs computed, and each one
 * validated as Graft validates any build.
 *
 *   npx tsx experiments/a2ui/promote.ts
 */

const root = new URL('../../', import.meta.url);
const read = async (path: string) => readFile(new URL(path, root), 'utf8');
const surface = JSON.parse(await read('hosts/wordpress/plugin/surfaces/7.1.json')) as Surface;
let failed = false;
for (const file of (await readdir(new URL('experiments/a2ui/compiled/', root))).filter((f) => f.endsWith('.a2ui.json')).sort()) {
	const id = file.replace(/\.a2ui\.json$/, '');
	const source = await read(`examples/specs/${id}.md`);
	const spec = validateSpec(source, { surface }).spec!;
	const example = JSON.parse(await read(`examples/builds/${id}.json`)) as Build;
	const compiled = JSON.parse(await read(`experiments/a2ui/compiled/${file}`)) as Build & { ui: Record<string, unknown> };
	const build = {
		graft: 1,
		spec: { id, hash: await hashSpec(source) },
		surface: example.surface,
		mount: example.mount,
		ui: { ...compiled.ui, protocol: 'a2ui/v0.9', catalogId: 'graft:wordpress' },
		events: compiled.events,
		data: compiled.data,
		checks: example.checks,
		refs: example.refs,
		provenance: { compiler: 'graft-compiler/0.1.0+a2ui', model: String(compiled.provenance?.model ?? 'claude-opus-5-5'), strategy: 'compiled' },
	} as Build;
	build.refs = extractRefs(build, surface);
	const { diagnostics } = await validateBuild(build, surface, { spec: { spec, hash: build.spec.hash } });
	const errors = diagnostics.filter((d) => d.severity === 'error');
	console.log(`${errors.length ? '✘' : '✔'} ${id}${errors.map((d) => `\n  ${d.code} ${d.path}: ${d.message}`).join('')}`);
	failed ||= errors.length > 0;
	await writeFile(new URL(`examples/a2ui/builds/${id}.json`, root), JSON.stringify(build, null, '\t') + '\n');
}
process.exit(failed ? 1 : 0);
