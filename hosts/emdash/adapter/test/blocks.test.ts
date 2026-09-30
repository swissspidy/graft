import { snapshotTree, validateBuild, type Build, type TreeNode } from '@graft/core';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { findAction, readValue, renderTree, withWidgetStates, type Block } from '../src/host/blocks.ts';
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

describe('widgets', () => {
	// The build's code, as plain functions: the renderer only sees ctx.fn.
	const code: Record<string, (...args: never[]) => unknown> = {
		draw: (rows: Array<{ id: string; title: string }>, state: { only?: string }) => ({
			type: 'stack',
			children: [
				{ type: 'actions', children: [{ type: 'button', props: { id: 'only-a', label: 'Only A', onClick: { $event: 'only', payload: { title: 'A' } } } }] },
				{
					type: 'table',
					props: {
						rows: rows.filter((row) => !state.only || row.title === state.only),
						columns: [{ key: 'title', label: 'Title', primary: true }],
						actions: [{ id: 'publish', label: 'Publish', onClick: { $use: 'publish' } }],
					},
				},
				{ type: 'actions', children: [{ type: 'button', props: { id: 'forged', label: 'Forged', onClick: { $use: 'publish', row: 'x' } } }] },
			],
		}),
		only: (_state: unknown, _event: string, payload: { title: string }) => ({ only: payload.title }),
	};
	const fn = (name: string, args: unknown[]) => (code[name] as (...a: unknown[]) => unknown)(...args);
	const widget: TreeNode = {
		type: 'stack',
		children: [
			{
				type: 'widget',
				props: {
					render: 'draw',
					update: 'only',
					input: { $data: 'q.items' },
					state: {},
					actions: {
						publish: {
							call: { $call: 'content.publish', input: { id: { $field: 'id' } }, then: ['refresh:q'] },
							visible: { $can: 'content.status:write' },
						},
					},
				},
			},
		],
	};
	const items = [entry('a', 'A', true), entry('b', 'B', false)];
	const limits = { components: ['stack', 'actions', 'button', 'table'], maxNodes: 50 };
	const draw = (states: Record<string, unknown> = {}) =>
		withWidgetStates(renderTree(widget, { ...ctx(items, { 'content.status:write': true }), fn }, 'spec', { limits, states }), 'spec');

	it('draws the tree the code returns, with events and the declared actions it offers', () => {
		const rendered = draw();
		expect(rendered.widgets['0.0']).toEqual({ props: expect.objectContaining({ render: 'draw' }), state: {} });
		const only = rendered.actions.find((a) => a.id === 'only-a')!;
		expect(only).toMatchObject({ available: true, event: { widget: '0.0', name: 'only', payload: { title: 'A' } } });
		// Declared actions resolve to the input's own rows, and only where visible holds.
		const publish = rendered.actions.filter((a) => a.id === 'publish');
		expect(publish.map((a) => [a.value, a.available, a.action?.input])).toEqual([
			['a', true, { id: 'a' }],
			['b', false, undefined],
		]);
		// A row the widget was not given is not offered, and is reported.
		expect(rendered.actions.find((a) => a.id === 'forged')?.available).toBe(false);
		expect(rendered.problems).toEqual(['A widget: The widget offers "publish" on a row that is not in its input.']);
	});

	it('carries the states in every button of the customization, and reads them back', () => {
		const rendered = draw({ '0.0': { only: 'A' } });
		const clicked = (rendered.blocks.flatMap((b) => (b.type === 'actions' ? (b.elements as Block[]) : [])) as Block[]).find((b) => b.label === 'Only A')!;
		const { value, states } = readValue(clicked.value);
		expect(states).toEqual({ '0.0': { only: 'A' } });
		expect(findAction(rendered, String(clicked.action_id), value)?.event?.name).toBe('only');
		// A table button keeps its row id next to the states.
		const table = rendered.blocks.find((b) => b.type === 'table') as Block & { rows: Array<Record<string, Block>> };
		const publish = Object.values(table.rows[0]!).find((cell) => typeof cell === 'object' && cell.type === 'button')!;
		expect(readValue(publish.value)).toEqual({ value: 'a', states: { '0.0': { only: 'A' } } });
		// Values without states are read as they are.
		expect(readValue('a')).toEqual({ value: 'a', states: {} });
		expect(readValue('w|not json')).toEqual({ value: 'w|not json', states: {} });
	});

	it('draws nothing where functions do not run, and sends no events outside a widget', () => {
		const rendered = renderTree(widget, ctx(items, {}), 'spec', { limits, states: {} });
		expect(rendered.blocks).toEqual([]);
		expect(rendered.problems).toEqual(['A widget cannot be drawn here.']);
		const loose = renderTree({ type: 'actions', children: [{ type: 'button', props: { id: 'x', label: 'X', onClick: { $event: 'x' } } }] }, ctx([], {}), 'spec');
		expect(loose.blocks).toEqual([]);
		expect(loose.actions[0]?.available).toBe(false);
	});

	it('reads in a snapshot as the verifier draws it', () => {
		const snapshot = snapshotTree(widget, { ...ctx(items, { 'content.status:write': true }), fn }, semantics, { limits, state: () => ({ has: false }) });
		expect(snapshot.actions.find((a) => a.id === 'only-a')).toMatchObject({ available: true, event: { widget: '/tree/children/0', name: 'only' } });
		expect(snapshot.tables[0]!.rows.map((row) => [row.label, row.actions[0]!.available])).toEqual([
			['A', true],
			['B', false],
		]);
	});
});

describe('examples', () => {
	it('are valid against the committed surface', async () => {
		const surface = JSON.parse(await readFile(new URL('../surfaces/1.0.json', import.meta.url), 'utf8'));
		for (const name of ['publish-queue', 'go-live', 'drafts-glance', 'stale-drafts', 'status-board']) {
			const build = JSON.parse(await readFile(new URL(`../../../../examples/emdash/builds/${name}.json`, import.meta.url), 'utf8')) as Build;
			const result = await validateBuild(build, surface);
			expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
		}
	});
});
