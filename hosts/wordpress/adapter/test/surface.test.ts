import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAjv, hashSpec, validateBuild, validateSpec, validateSurface, type Surface } from '@graft/core';
import { assembleSurface, components, paths, type HostDump } from '../src/index.ts';

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

	it.each(surfaceFiles)('%s carries the adapter components unchanged', (file) => {
		expect(load(file).components).toEqual(components);
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
			accepts: ['row-action'],
		});
		expect(surface.capabilities['posts.list']).toMatchObject({ kind: 'read', scopes: ['posts:read'], binding: { ability: 'graft/posts-list' } });
		expect(surface.capabilities['posts.update_status']).toMatchObject({ kind: 'write', scopes: ['posts.status:write'] });
	});
});

describe('components', () => {
	const ajv = createAjv();

	it('accept the props a review-queue table needs', () => {
		const validate = ajv.compile(components.table!.props);
		const props = {
			rows: [{ id: 1, title: 'Draft A' }],
			fields: [
				{ id: 'title', label: 'Title', primary: true },
				{ id: 'author.name', label: 'Author', type: 'user' },
				{ id: 'date', label: 'Submitted', type: 'datetime' },
			],
			actions: [
				{
					id: 'approve',
					label: 'Approve',
					visible: { $can: 'posts.status:write', on: { $field: 'id' } },
					onClick: { $call: 'posts.update_status', input: { id: { $field: 'id' }, status: 'publish' }, then: ['remove-row:queue'] },
				},
			],
			empty: 'Nothing to review',
		};
		expect(validate(props), JSON.stringify(validate.errors)).toBe(true);
		expect(validate({ ...props, html: '<script>' })).toBe(false);
		expect(validate({ ...props, actions: [{ id: 'x', label: 'X', onClick: 'alert(1)' }] })).toBe(false);
	});

	it('are about eight, as the ADR planned', () => {
		// Plus the widget, which draws with the others (ADR 0006).
		expect(Object.keys(components).sort()).toEqual(['button', 'card', 'empty-state', 'heading', 'notice', 'row-action', 'stack', 'table', 'text', 'widget']);
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
