import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ajvEngine, setSchemaEngine, validateBuild, validateSpec, type Build, type Surface } from '../src/index.ts';
import { cfworkerEngine } from '../src/schema-cfworker.ts';
// The hosts' A2UI formats read the example builds.
import '../../../hosts/wordpress/adapter/src/a2ui.ts';
import '../../../hosts/emdash/adapter/src/host/a2ui.ts';

/**
 * The cfworker engine (for runtimes without code generation) must accept
 * and reject the same things as Ajv, at the same places.
 */

const root = join(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const hosts = [
	{ surface: 'hosts/wordpress/plugin/surfaces/7.1.json', examples: ['review-queue', 'quick-approve', 'waiting-posts'], dir: 'examples' },
	{ surface: 'hosts/emdash/adapter/surfaces/1.0.json', examples: ['publish-queue', 'go-live', 'drafts-glance'], dir: 'examples/emdash' },
];

type Mutation = [string, (build: Build) => void];
const mutations: Mutation[] = [
	['unknown top-level field', (b) => ((b as unknown as Record<string, unknown>).extra = 1)],
	['missing ui', (b) => delete (b as Partial<Build>).ui],
	['unknown component', (b) => ((b.ui.components as Array<Record<string, unknown>>)[0]!.component = 'Marquee')],
	['bad prop value', (b) => ((b.ui.components as Array<Record<string, unknown>>)[0]!.nonsense = true)],
	['unknown capability', (b) => (b.data = { x: { call: 'nope.nothing', input: {} } })],
	['check with a bad shape', (b) => (b.checks[0] = { criterion: 42 } as unknown as Build['checks'][number])],
	['stale refs', (b) => (b.refs.capabilities = [])],
];

const summarize = (diagnostics: Array<{ severity: string; code: string; path?: string }>) =>
	diagnostics
		.filter((d) => d.severity === 'error')
		.map((d) => `${d.code} ${d.path ?? ''}`)
		.sort();

async function run(engine: 'ajv' | 'cfworker') {
	setSchemaEngine(engine === 'ajv' ? ajvEngine() : cfworkerEngine());
	const out: Record<string, string[]> = {};
	for (const host of hosts) {
		const surface = JSON.parse(read(host.surface)) as Surface;
		for (const name of host.examples) {
			const source = read(`${host.dir}/specs/${name}.md`);
			out[`${name}: spec`] = summarize(validateSpec(source, { surface }).diagnostics);
			const build = JSON.parse(read(`${host.dir}/builds/${name}.json`)) as Build;
			out[`${name}: build`] = summarize((await validateBuild(build, surface)).diagnostics);
			for (const [label, mutate] of mutations) {
				const copy = structuredClone(build);
				mutate(copy);
				out[`${name}: ${label}`] = summarize((await validateBuild(copy, surface)).diagnostics);
			}
		}
		out[`${host.surface}: bad frontmatter`] = summarize(validateSpec('---\ngraft: 2\nid: X\nhost: wordpress\nmount: {}\n---\n# T\n', { surface }).diagnostics);
	}
	return out;
}

describe('schema engines', () => {
	afterAll(() => setSchemaEngine(ajvEngine()));

	it('agree on every example and on broken builds', async () => {
		const ajv = await run('ajv');
		const cfworker = await run('cfworker');
		for (const [key, value] of Object.entries(ajv)) {
			if (key.endsWith(': spec') || key.endsWith(': build')) {
				expect(value, key).toEqual([]);
			}
		}
		expect(cfworker).toEqual(ajv);
		// The mutations are actually caught.
		expect(Object.entries(ajv).filter(([k, v]) => !k.endsWith(': spec') && !k.endsWith(': build') && v.length === 0).map(([k]) => k)).toEqual([]);
	});

	it('describe errors the same way', async () => {
		const surface = JSON.parse(read('hosts/emdash/adapter/surfaces/1.0.json')) as Surface;
		const build = JSON.parse(read('examples/emdash/builds/publish-queue.json')) as Build;
		(build.data.queue!.input as Record<string, unknown>).status = 'pending';
		const messages = async (engine: 'ajv' | 'cfworker') => {
			setSchemaEngine(engine === 'ajv' ? ajvEngine() : cfworkerEngine());
			return (await validateBuild(build, surface)).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
		};
		expect(await messages('cfworker')).toEqual(await messages('ajv'));
	});

	it('leave the schemas they are given untouched', async () => {
		const surface = JSON.parse(read('hosts/emdash/adapter/surfaces/1.0.json')) as Surface;
		const before = JSON.stringify(surface);
		setSchemaEngine(cfworkerEngine());
		await validateBuild(JSON.parse(read('examples/emdash/builds/go-live.json')) as Build, surface);
		expect(JSON.stringify(surface)).toBe(before);
	});
});
