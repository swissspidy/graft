import { snapshotTree, validateBuild, type Build, type TreeNode } from '@graft/core';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { findAction, renderTree } from '../src/host/blocks.ts';
import { createCan } from '../src/host/can.ts';
import { semantics } from '../src/host/semantics.ts';

const entry = (id: string, title: string, publish: boolean) => ({ id, collection: 'posts', title, status: 'draft', author: { id: 'u1', name: 'Ada' }, can: { publish } });

const table: TreeNode = {
	type: 'stack',
	children: [
		{ type: 'header', props: { text: 'Queue' } },
		{
			type: 'table',
			props: {
				rows: { $data: 'q.items' },
				columns: [
					{ key: 'title', label: 'Title', primary: true },
					{ key: 'author.name', label: 'Author' },
				],
				actions: [
					{
						id: 'publish',
						label: 'Publish',
						style: 'primary',
						visible: { $can: 'content.status:write' },
						onClick: { $call: 'content.publish', input: { id: { $field: 'id' } }, then: ['refresh:q'], notice: 'Done.' },
					},
				],
				empty: 'Nothing waiting',
			},
		},
	],
};

const ctx = (items: unknown[], usable: Record<string, boolean>) => ({ data: { q: { items } }, slot: {}, can: createCan(usable) });

describe('renderTree', () => {
	it('translates a table with per-row buttons into Block Kit', () => {
		const rendered = renderTree(table, ctx([entry('a', 'Draft A', true), entry('b', 'Draft B', false)], { 'content.status:write': true }), 'queue');
		expect(rendered.blocks[0]).toEqual({ type: 'header', text: 'Queue' });
		const block = rendered.blocks[1]!;
		expect(block.type).toBe('table');
		expect(block.columns).toEqual([
			{ key: 'c0', label: 'Title' },
			{ key: 'c1', label: 'Author' },
			{ key: 'queue:0.1:0', label: '', format: 'element' },
		]);
		const rows = block.rows as Array<Record<string, unknown>>;
		expect(rows[0]).toEqual({ c0: 'Draft A', c1: 'Ada', 'queue:0.1:0': { type: 'button', action_id: 'queue:0.1:0', label: 'Publish', style: 'primary', value: 'a' } });
		// The entry's own flags refine $can: no button on B.
		expect(rows[1]).toEqual({ c0: 'Draft B', c1: 'Ada' });
		expect(block.empty_text).toBe('Nothing waiting');
	});

	it('resolves a click only to an action the fresh render still offers', () => {
		const rendered = renderTree(table, ctx([entry('a', 'Draft A', true), entry('b', 'Draft B', false)], { 'content.status:write': true }), 'queue');
		expect(findAction(rendered, 'queue:0.1:0', 'a')?.action).toMatchObject({ capability: 'content.publish', input: { id: 'a' }, notice: 'Done.' });
		expect(findAction(rendered, 'queue:0.1:0', 'b')).toBeUndefined();
		expect(findAction(rendered, 'queue:0.1:0', 'zzz')).toBeUndefined();
		expect(findAction(rendered, 'other:0.1:0', 'a')).toBeUndefined();
	});

	it('hides buttons when the scope is not usable', () => {
		const rendered = renderTree(table, ctx([entry('a', 'Draft A', true)], {}), 'queue');
		expect((rendered.blocks[1]!.rows as Array<Record<string, unknown>>)[0]).toEqual({ c0: 'Draft A', c1: 'Ada' });
		expect(rendered.actions.every((a) => !a.available)).toBe(true);
	});

	it('groups buttons into actions blocks and drops invisible ones', () => {
		const tree: TreeNode = {
			type: 'stack',
			children: [
				{ type: 'banner', props: { title: 'Hidden', visible: false } },
				{ type: 'button', props: { id: 'a', label: 'A', onClick: { $call: 'content.publish', input: { id: '1' } } } },
				{ type: 'button', props: { id: 'b', label: 'B', onClick: { $call: 'content.publish', input: { id: '2' } } } },
				{ type: 'actions', children: [{ type: 'button', props: { id: 'c', label: 'C', visible: false, onClick: { $call: 'content.publish', input: { id: '3' } } } }] },
			],
		};
		const { blocks } = renderTree(tree, ctx([], {}), 'x');
		expect(blocks).toEqual([
			{
				type: 'actions',
				elements: [
					{ type: 'button', action_id: 'x:0.1', label: 'A' },
					{ type: 'button', action_id: 'x:0.2', label: 'B' },
				],
			},
		]);
	});
});

describe('semantics', () => {
	it('reads what the Block Kit translation shows', () => {
		const snapshot = snapshotTree(table, ctx([entry('a', 'Draft A', true), entry('b', 'Draft B', false)], { 'content.status:write': true }), semantics);
		expect(snapshot.texts).toEqual(['Queue', 'Draft A', 'Draft B']);
		expect(snapshot.tables[0]!.columns).toEqual(['Title', 'Author']);
		expect(snapshot.tables[0]!.rows.map((r) => [r.label, r.actions[0]!.available])).toEqual([
			['Draft A', true],
			['Draft B', false],
		]);
		const empty = snapshotTree(table, ctx([], { 'content.status:write': true }), semantics);
		expect(empty.texts).toContain('Nothing waiting');
	});

	it('reports only the tones the admin shows, and labels rows by what the primary column shows', () => {
		const toned: TreeNode = {
			type: 'table',
			props: {
				rows: { $data: 'q.items' },
				columns: [
					{ key: 'name', label: 'Name', primary: true, value: { $field: 'title' } },
					{ key: 'title', label: 'Marked', tone: { $field: 'tone' } },
					{ key: 'title', label: 'When', format: 'relative_time', tone: 'error' },
				],
			},
		};
		const rows = [
			{ ...entry('a', 'Draft A', true), tone: 'warning' },
			{ ...entry('b', 'Draft B', true), tone: 'constructor' },
		];
		const snapshot = snapshotTree(toned, ctx(rows, {}), semantics);
		expect(snapshot.tables[0]!.rows.map((r) => [r.label, r.cells])).toEqual([
			['Draft A', { Name: { text: 'Draft A' }, Marked: { text: 'Draft A', tone: 'warning' }, When: { text: 'Draft A' } }],
			['Draft B', { Name: { text: 'Draft B' }, Marked: { text: 'Draft B' }, When: { text: 'Draft B' } }],
		]);
	});
});

describe('examples', () => {
	it('are valid against the committed surface', async () => {
		const surface = JSON.parse(await readFile(new URL('../surfaces/1.0.json', import.meta.url), 'utf8'));
		for (const name of ['publish-queue', 'go-live', 'drafts-glance']) {
			const build = JSON.parse(await readFile(new URL(`../../../../examples/emdash/builds/${name}.json`, import.meta.url), 'utf8')) as Build;
			const result = await validateBuild(build, surface);
			expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
		}
	});
});
