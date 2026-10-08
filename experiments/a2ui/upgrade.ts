import { readdir, readFile } from 'node:fs/promises';
import { canonicalJson, validateSpec, type Spec, type Surface, type Verification } from '../../packages/core/src/index.ts';
import { anthropicModel } from '../../packages/cli/src/anthropic.ts';
import { scenarios, scenarioSurface } from '../../hosts/wordpress/adapter/src/canary.ts';
import { startSandbox, type WordPressSandbox } from '../../hosts/wordpress/adapter/src/sandbox.ts';
import { verifyA2UI } from './compile.ts';
import { a2uiRefs, compileA2UI } from './compiler.ts';
import { migrateA2UI, reanchorA2UI } from './migrate.ts';
import type { A2UIBuild } from './snapshot.ts';

/**
 * The upgrade ladder for A2UI builds against the WordPress canary's
 * synthetic host changes: reverify, migrate (declared renames), regenerate
 * (the A2UI compiler with the frozen checks and the old build as reference,
 * only with REGENERATE=1 and an API key), and needs_approval when the new
 * host wants scopes beyond the grant. Re-anchoring is left out: no
 * scenario moves a slot these builds mount in.
 *
 *   npx tsx experiments/a2ui/upgrade.ts [scenario ...]
 */

const root = new URL('../../', import.meta.url);
const read = async (path: string) => readFile(new URL(path, root), 'utf8');
const from = JSON.parse(await read('hosts/wordpress/plugin/surfaces/7.1.json')) as Surface;

const corpus: Array<{ name: string; spec: string; build: A2UIBuild }> = [
	{ name: 'review-queue (handwritten)', spec: 'review-queue', build: JSON.parse(await read('experiments/a2ui/review-queue.a2ui.json')) },
];
for (const file of (await readdir(new URL('experiments/a2ui/compiled/', root))).filter((f) => f.endsWith('.a2ui.json')).sort()) {
	const spec = file.replace(/\.a2ui\.json$/, '');
	corpus.push({ name: spec, spec, build: JSON.parse(await read(`experiments/a2ui/compiled/${file}`)) });
}
const specs = new Map<string, Spec>();
for (const { spec: id } of corpus) {
	const { spec } = validateSpec(await read(`examples/specs/${id}.md`), { surface: from });
	specs.set(id, spec!);
}
const model = process.env.REGENERATE ? anthropicModel({}) : undefined;

type Outcome = 'survived' | 'migrated' | 'reanchored' | 'regenerated' | 'needs_approval' | 'failed';

async function upgrade(build: A2UIBuild, spec: Spec, to: Surface, sandbox: WordPressSandbox): Promise<{ outcome: Outcome; path: string[] }> {
	const grant = spec.manifest.permissions;
	const path: string[] = [];
	const tried = new Set<string>();
	const attempt = async (rung: string, candidate: A2UIBuild | undefined, outcome: Outcome): Promise<Outcome | undefined> => {
		if (!candidate) {
			path.push(`${rung}: does not apply`);
			return undefined;
		}
		const rebased: A2UIBuild = { ...candidate, surface: { host: to.host, hostVersion: to.hostVersion, hash: to.hash ?? '' } };
		rebased.refs = a2uiRefs(rebased, rebased.mount.slot, to);
		const key = canonicalJson({ ui: rebased.ui, data: rebased.data, events: rebased.events, mount: rebased.mount });
		if (tried.has(key)) {
			path.push(`${rung}: same candidate as before`);
			return undefined;
		}
		tried.add(key);
		const missing = rebased.refs.capabilities.filter((name) => !to.capabilities[name]);
		if (missing.length) {
			path.push(`${rung}: uses ${missing.join(', ')}, which the host no longer has`);
			return undefined;
		}
		const extra = rebased.refs.scopes.filter((scope) => !grant.includes(scope));
		const verification: Verification = await verifyA2UI(rebased, spec, to, sandbox, [...grant, ...extra]);
		const failing = verification.results.filter((r) => !r.passed).map((r) => r.criterion);
		path.push(`${rung}: ${verification.passed ? 'checks pass' : `checks fail: ${[...new Set(failing)].join(', ')}`}`);
		if (!verification.passed) {
			return undefined;
		}
		return extra.length ? 'needs_approval' : outcome;
	};

	// A slot that is gone or deprecated: the build has to move, so reverifying in place does not count.
	const slot = to.slots[build.mount.slot];
	const moving = !slot || slot.deprecated === true;
	const reverified = moving ? (path.push(`reverify: slot ${build.mount.slot} is ${slot ? 'deprecated' : 'gone'}`), undefined) : await attempt('reverify', structuredClone(build), 'survived');
	if (reverified) {
		return { outcome: reverified, path };
	}
	const migratedBuild = (to.migrations ?? []).length ? migrateA2UI(build, to.migrations!) : undefined;
	const migrated = moving && migratedBuild?.mount.slot === build.mount.slot ? undefined : await attempt('migrate', migratedBuild, 'migrated');
	if (migrated) {
		return { outcome: migrated, path };
	}
	if (moving) {
		const reanchored = await attempt('reanchor', reanchorA2UI(migratedBuild ?? build, from, to), 'reanchored');
		if (reanchored) {
			return { outcome: reanchored, path };
		}
	}
	if (!model) {
		path.push('regenerate: no compiler (REGENERATE=1)');
		return { outcome: 'failed', path };
	}
	const { ui: _ui, data: _data, events: _events, refs: _refs, provenance: _provenance, ...envelope } = build;
	const result = await compileA2UI({
		spec,
		surface: to,
		checks: build.checks,
		envelope,
		model,
		previous: build,
		verify: (candidate) => verifyA2UI(candidate, spec, to, sandbox, [...grant, ...candidate.refs.scopes.filter((s) => !grant.includes(s))]),
	});
	const regenerated = await attempt('regenerate', result.ok ? result.build : undefined, 'regenerated');
	return { outcome: regenerated ?? 'failed', path };
}

const wanted = process.argv.slice(2);
const sandbox = await startSandbox({});
const table: string[] = [];
try {
	for (const scenario of scenarios.filter((s) => wanted.length === 0 || wanted.includes(s.name))) {
		const to = await scenarioSurface(sandbox, from, scenario);
		console.log(`\n## ${scenario.name}: ${scenario.description}`);
		for (const entry of corpus) {
			const { outcome, path } = await upgrade(entry.build, specs.get(entry.spec)!, to, sandbox);
			const tree = scenario.expect[entry.spec];
			console.log(`- ${entry.name}: ${outcome} (tree build: ${tree})\n    ${path.join('\n    ')}`);
			table.push(`| ${scenario.name} | ${entry.name} | ${outcome} | ${tree} |`);
		}
		await sandbox.patch({});
	}
} finally {
	await sandbox.close();
}
console.log(`\n| Scenario | Build | A2UI | Tree |\n| --- | --- | --- | --- |\n${table.join('\n')}`);
