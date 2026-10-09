import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashSpec, validateBuild, validateSpec, validateSurface, type Surface } from '@swissspidy/graft-core';
import { assembleSurface, paths, type HostDump } from '../src/index.ts';

const examplesDir = join(import.meta.dirname, '../../../../examples/specs');
const surfaceFiles = readdirSync(paths.surfaces).filter((f) => f.endsWith('.json'));

function load(file: string): Surface {
	return JSON.parse(readFileSync(join(paths.surfaces, file), 'utf8')) as Surface;
}

describe('checked-in surfaces', () => {
	it.each(surfaceFiles)('%s is valid and its hash matches its content', async (file) => {
		const result = await validateSurface(load(file));
		expect(result.diagnostics).toEqual([]);
		expect(result.hash).toBe(load(file).hash);
	});

	it.each(surfaceFiles)('every example spec validates against %s', (file) => {
		const surface = load(file);
		for (const example of readdirSync(examplesDir)) {
			const result = validateSpec(readFileSync(join(examplesDir, example), 'utf8'), { surface });
			expect(result.diagnostics, example).toEqual([]);
		}
	});

	it('the example builds are valid for 7.1 and their specs', async () => {
		const surface = load('7.1.json');
		const buildsDir = join(examplesDir, '../builds');
		for (const file of readdirSync(buildsDir)) {
			const build = JSON.parse(readFileSync(join(buildsDir, file), 'utf8'));
			const source = readFileSync(join(examplesDir, file.replace(/\.json$/, '.md')), 'utf8');
			const spec = validateSpec(source, { surface }).spec!;
			const result = await validateBuild(build, surface, { spec: { spec, hash: await hashSpec(source) } });
			expect(result.diagnostics, file).toEqual([]);
		}
	});

	it('7.1 has owned and extension slots and the post capabilities', () => {
		const surface = load('7.1.json');
		expect(surface.slots['admin.page']?.kind).toBe('owned');
		expect(surface.slots['posts.list.row-actions']).toMatchObject({
			kind: 'extension',
			screen: 'edit-post',
			anchor: 'filter:post_row_actions',
		});
		expect(surface.capabilities['posts.list']).toMatchObject({ kind: 'read', scopes: ['posts:read'], binding: { ability: 'graft/posts-list' } });
		expect(surface.capabilities['posts.update_status']).toMatchObject({ kind: 'write', scopes: ['posts.status:write'] });
	});
});

describe('the agency example (examples/agency)', () => {
	const agencyDir = join(examplesDir, '../agency');
	const surface = JSON.parse(readFileSync(join(agencyDir, 'surface.json'), 'utf8')) as Surface;

	it("is a valid surface of the Riverside site's content model", async () => {
		const result = await validateSurface(surface);
		expect(result.diagnostics).toEqual([]);
		expect(result.hash).toBe(surface.hash);
		const model = surface.model as { postTypes: Record<string, { fields: Record<string, unknown>; taxonomies: string[] }> };
		expect(Object.keys(model.postTypes)).toEqual(['event', 'page', 'post']);
		expect(Object.keys(model.postTypes.event!.fields)).toEqual(['capacity', 'event_date', 'sold_out', 'venue']);
		expect(model.postTypes.event!.taxonomies).toEqual(['event_type']);
	});

	it('has builds valid for it and their specs', async () => {
		for (const file of readdirSync(join(agencyDir, 'builds'))) {
			const build = JSON.parse(readFileSync(join(agencyDir, 'builds', file), 'utf8'));
			const source = readFileSync(join(agencyDir, 'specs', file.replace(/\.json$/, '.md')), 'utf8');
			const spec = validateSpec(source, { surface }).spec!;
			const result = await validateBuild(build, surface, { spec: { spec, hash: await hashSpec(source) } });
			expect(result.diagnostics, file).toEqual([]);
		}
	});

	it('ships managed bundles made from the current specs and builds (pnpm bundle:agency)', async () => {
		for (const file of readdirSync(join(agencyDir, 'managed'))) {
			const bundle = JSON.parse(readFileSync(join(agencyDir, 'managed', file), 'utf8'));
			const id = file.replace(/\.json$/, '');
			expect(bundle.spec.source, file).toBe(readFileSync(join(agencyDir, 'specs', `${id}.md`), 'utf8'));
			expect(bundle.builds.map((b: { build: unknown }) => b.build), file).toEqual([JSON.parse(readFileSync(join(agencyDir, 'builds', `${id}.json`), 'utf8'))]);
			expect(bundle.builds.every((b: { verification: { passed: boolean } }) => b.verification.passed), file).toBe(true);
		}
	});
});

describe('assembleSurface', () => {
	it('normalizes host schemas, sorts maps and hashes the result', async () => {
		const dump: HostDump = {
			graft: 1,
			host: 'wordpress',
			hostVersion: '7.1.2',
			slots: { 'z.slot': { kind: 'owned', title: 'Z', provides: { type: 'object', properties: [] } as never }, 'a.slot': { kind: 'owned', title: 'A' } },
			capabilities: {
				'site.info': {
					kind: 'read',
					input: { type: 'object', properties: [], default: [] } as never,
					output: { type: 'object' },
					scopes: ['site:read'],
				},
			},
			scopes: { 'site:read': { title: 'See site settings' } },
			audiences: ['administrator'],
			fingerprint: 'sha256:' + '0'.repeat(64),
		};
		const surface = await assembleSurface(dump);
		expect(Object.keys(surface.slots)).toEqual(['a.slot', 'z.slot']);
		expect(surface.slots['z.slot']?.provides).toEqual({ type: 'object', properties: {} });
		expect(surface.capabilities['site.info']?.input).toEqual({ type: 'object', properties: {}, default: {} });
		const result = await validateSurface(surface);
		expect(result.diagnostics).toEqual([]);
		expect(result.hash).toBe(surface.hash);
	});
});
