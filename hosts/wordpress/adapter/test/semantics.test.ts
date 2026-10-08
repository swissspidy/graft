import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allActions, snapshotTree, type Build } from '@graft/core';
import { createCan, semantics } from '../src/index.ts';

const builds = join(import.meta.dirname, '../../../../examples/builds');
const load = (name: string) => JSON.parse(readFileSync(join(builds, `${name}.json`), 'utf8')) as Build;

const post = (id: number, title: string, publish: boolean) => ({
	id,
	title,
	status: 'pending',
	type: 'post',
	author: { id: 2, name: 'Contributor User' },
	date: '2026-09-28T10:00:00Z',
	modified: '2026-09-28T10:00:00Z',
	can: { edit: true, publish },
});

describe('WordPress semantics', () => {
	it('read the review queue the way the table renders it', () => {
		const build = load('review-queue');
		const snapshot = snapshotTree(
			build.tree!,
			{
				data: { queue: { items: [post(1, 'Draft A', true), post(2, 'Draft B', false)], total: 2, pages: 1 } },
				slot: {},
				can: createCan({ 'posts:read': true, 'posts.status:write': true }),
			},
			semantics,
		);
		expect(snapshot.tables).toHaveLength(1);
		expect(snapshot.tables[0]!.columns).toEqual(['Title', 'Author', 'Submitted']);
		expect(snapshot.tables[0]!.rows.map((r) => [r.label, r.actions.map((a) => `${a.id}:${a.available}`)])).toEqual([
			['Draft A', ['approve:true']],
			['Draft B', ['approve:false']],
		]);
		expect(snapshot.texts).toContain('Review queue');
		expect(snapshot.texts).not.toContain('Nothing to review');
	});

	it('show the empty text when there are no rows', () => {
		const snapshot = snapshotTree(load('review-queue').tree!, { data: { queue: { items: [] } }, slot: {}, can: () => true }, semantics);
		expect(snapshot.texts).toContain('Nothing to review');
	});

	it('make the quick approve row action depend on status and permission', () => {
		const tree = load('quick-approve').tree!;
		const can = createCan({ 'posts.status:write': true });
		const available = (p: Record<string, unknown>) =>
			allActions(snapshotTree(tree, { data: {}, slot: { post: p }, can }, semantics)).map((a) => a.available);
		expect(available({ id: 1, status: 'pending', can: { publish: true } })).toEqual([true]);
		expect(available({ id: 1, status: 'draft', can: { publish: true } })).toEqual([false]);
		expect(available({ id: 1, status: 'pending', can: { publish: false } })).toEqual([false]);
	});
});
