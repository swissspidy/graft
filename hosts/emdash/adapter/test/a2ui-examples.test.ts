import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateBuild, validateSpec, type Build, type Surface } from '@graft/core';
import '../src/host/a2ui.ts';

// Tests run from the repository root.
const read = (path: string) => readFileSync(`${process.cwd()}/${path}`, 'utf8');
const surface = JSON.parse(read('hosts/emdash/adapter/surfaces/1.0.json')) as Surface;
const builds = readdirSync(`${process.cwd()}/examples/emdash/a2ui/builds`).filter((f) => f.endsWith('.json'));

describe('the EmDash A2UI example builds', () => {
	it.each(builds)('%s is valid for its spec', async (file) => {
		const build = JSON.parse(read(`examples/emdash/a2ui/builds/${file}`)) as Build;
		const spec = validateSpec(read(`examples/emdash/specs/${build.spec.id}.md`), { surface }).spec!;
		const errors = (await validateBuild(build, surface, { spec: { spec, hash: build.spec.hash } })).diagnostics.filter((d) => d.severity === 'error');
		expect(errors).toEqual([]);
	});
});
