import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { answerA2UI, assembleA2UI, type A2UIBuild } from '@graft/a2ui';
import { validateBuild, validateSpec, type Build, type Surface } from '@graft/core';
import '../src/a2ui.ts';

// Tests run from the repository root.
const read = (path: string) => readFileSync(`${process.cwd()}/${path}`, 'utf8');
const surface = JSON.parse(read('hosts/wordpress/plugin/surfaces/7.1.json')) as Surface;
const builds = readdirSync(`${process.cwd()}/examples/builds`).filter((f) => f.endsWith('.json'));

describe('the example builds', () => {
	it.each(builds)('%s is valid for its spec', async (file) => {
		const build = JSON.parse(read(`examples/builds/${file}`)) as Build;
		const spec = validateSpec(read(`examples/specs/${build.spec.id}.md`), { surface }).spec!;
		const errors = (await validateBuild(build, surface, { spec: { spec, hash: build.spec.hash } })).diagnostics.filter((d) => d.severity === 'error');
		expect(errors).toEqual([]);
	});

	it.each(builds)('%s survives being written out as model output and assembled again', (file) => {
		const build = JSON.parse(read(`examples/builds/${file}`)) as A2UIBuild;
		expect(assembleA2UI(answerA2UI(build), build.ui.catalogId)).toEqual({ value: { ui: build.ui, data: build.data, events: build.events }, problems: [] });
	});
});
