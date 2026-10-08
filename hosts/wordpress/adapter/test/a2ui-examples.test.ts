import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateBuild, validateSpec, type Build, type Surface } from '@graft/core';
import '../src/a2ui.ts';

// Tests run from the repository root.
const read = (path: string) => readFileSync(`${process.cwd()}/${path}`, 'utf8');
const surface = JSON.parse(read('hosts/wordpress/plugin/surfaces/7.1.json')) as Surface;
const builds = readdirSync(`${process.cwd()}/examples/a2ui/builds`).filter((f) => f.endsWith('.json'));

describe('the A2UI example builds', () => {
	it.each(builds)('%s is valid for its spec', async (file) => {
		const build = JSON.parse(read(`examples/a2ui/builds/${file}`)) as Build;
		const spec = validateSpec(read(`examples/specs/${build.spec.id}.md`), { surface }).spec!;
		const errors = (await validateBuild(build, surface, { spec: { spec, hash: build.spec.hash } })).diagnostics.filter((d) => d.severity === 'error');
		expect(errors).toEqual([]);
	});
});
