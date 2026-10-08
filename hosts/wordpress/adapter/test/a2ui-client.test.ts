// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { A2UIBuild } from '@graft/a2ui/client';
import { createProcessor, surfaceId } from '../src/client/a2ui.tsx';

// Tests run from the repository root.
const example = (name: string) => JSON.parse(readFileSync(`${process.cwd()}/examples/a2ui/builds/${name}.json`, 'utf8')) as A2UIBuild;
const can = () => true;

describe('the A2UI client', () => {
	it('seeds the model from the slot as the verifier does, with copies of the build’s values', () => {
		const build = example('publish-checklist');
		const before = JSON.stringify(build);
		const processor = createProcessor(build, { post: { id: 7, title: 'Draft B', excerpt: '', status: 'draft', can: { edit: true, publish: true } } }, can);
		const model = processor.getSurface(surfaceId)!.dataModel;
		expect(model.get('/form/title')).toBe('Draft B');
		expect(model.get('/form/facts')).toBe(false);
		model.set('/form/facts', true);
		expect(JSON.stringify(build)).toBe(before);
	});

	it('recomputes `computed` as the model changes', () => {
		const build = example('pending-by-author');
		const processor = createProcessor(build, {}, can);
		const model = processor.getSurface(surfaceId)!.dataModel;
		model.set('/pending', {
			items: [
				{ id: 1, title: 'Ada one', author: { id: 3, name: 'Ada' } },
				{ id: 2, title: 'Bob one', author: { id: 4, name: 'Bob' } },
			],
		});
		expect((model.get('/authors') as unknown[]).length).toBe(2);
		expect((model.get('/shown') as unknown[]).length).toBe(2);
		// What the author buttons' `set` writes.
		model.set('/form/author', 4);
		expect((model.get('/shown') as Array<{ title: string }>).map((p) => p.title)).toEqual(['Bob one']);
	});
});
