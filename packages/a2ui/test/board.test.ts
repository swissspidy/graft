import { describe, expect, it } from 'vitest';
import { extractRefs, hashSurface, registerUiFormat, validateBuild, verifyBuild, type Build, type Surface } from '@swissspidy/graft-core';
import { createCan, fakeSandbox, fixtures, pageBuild, spec, surface as acme } from '../../core/test/fixtures/acme.ts';
import { BOARD_COMPONENT, boardLanes, createA2UIFormat, snapshotA2UI, validateA2UI, type A2UIBuild, type A2UIHost } from '../src/index.ts';

/** Acme with a host that draws boards: items in an Open and a Done column. */
const host: A2UIHost = { catalogId: 'graft:board', components: [BOARD_COMPONENT] };
const surface: Surface = { ...acme, host: 'board' };
registerUiFormat(createA2UIFormat({ host: 'board', ...host }));

const board = {
	id: 'board',
	component: 'Board',
	items: { path: '/items/items' },
	columnBy: 'status',
	columns: [
		{ id: 'open', title: 'Open', empty: 'Nothing open' },
		{ id: 'done', title: 'Done', empty: 'Nothing done' },
	],
	fields: [
		{ id: 'title', label: 'Title', primary: true },
		{ id: 'status', label: 'Status' },
	],
	moves: [{ id: 'close', label: 'Done →', from: 'open', to: 'done', visible: { call: 'can', args: { scope: 'items:write' } }, action: { event: { name: 'close', context: { id: { path: 'id' } } } } }],
};

async function boardBuild(change?: (component: Record<string, unknown>) => void): Promise<A2UIBuild> {
	const build = (await pageBuild({})) as unknown as A2UIBuild;
	const component = structuredClone(board) as Record<string, unknown>;
	change?.(component);
	build.surface = { host: 'board', hostVersion: '1.0', hash: await hashSurface(surface) };
	build.data = { items: { call: 'items.list', input: {} } };
	build.ui = { protocol: 'a2ui/v0.9', catalogId: 'graft:board', components: [{ id: 'root', component: 'Column', children: ['board'] }, component as never] };
	build.events = { close: { call: 'items.close', input: { id: { $context: 'id' } }, then: ['refresh:items'] } };
	build.checks = [
		{ criterion: 'open-only', fixtures, view_as: 'm', expect: [{ rows: ['Open A'] }, { text: 'Done' }, { cell: { row: { title: 'Done B' }, column: 'Status', text: 'done' } }] },
		{ criterion: 'close', fixtures, view_as: 'm', steps: [{ action: 'close', row: { title: 'Open A' } }], expect: [{ rows: [] }, { text: 'Nothing open' }, { item: { title: 'Open A', status: 'done' } }] },
		{ criterion: 'clerks', fixtures, view_as: 'c', expect: [{ action: 'close', row: { title: 'Open A' }, available: false }] },
		{ criterion: 'empty', fixtures: { ...fixtures, items: [] }, view_as: 'm', expect: [{ text: 'Nothing open' }, { text: 'Nothing done' }] },
	];
	(build as unknown as Build).refs = extractRefs(build as unknown as Build, surface);
	return build;
}

const items = [
	{ id: 1, title: 'Open A', status: 'open' },
	{ id: 2, title: 'Done B', status: 'done' },
	{ id: 3, title: 'Open C', status: 'open' },
	{ id: 4, title: 'Lost D', status: 'archived' },
];

describe('boardLanes', () => {
	it('puts each item in the column of its value, keeps empty columns, and leaves out items of no column', () => {
		const lanes = boardLanes(items, 'status', board.columns);
		expect(lanes.map(({ column, cards }) => [column.id, cards.map((card) => [card.item.title, card.index])])).toEqual([
			['open', [['Open A', 0], ['Open C', 2]]],
			['done', [['Done B', 1]]],
		]);
		expect(boardLanes([], 'status', board.columns).map((lane) => lane.cards)).toEqual([[], []]);
		expect(boardLanes([{ meta: { lane: 'done' } }], 'meta/lane', board.columns)[1]!.cards).toHaveLength(1);
	});
});

describe('the Board', () => {
	it('reads as one table per column, with the moves out of it as row actions', async () => {
		const build = await boardBuild();
		const snapshot = snapshotA2UI(build, { data: { items: { items } }, slot: {}, can: (scope) => scope === 'items:write' }, {}, host);
		expect(snapshot.problems).toBeUndefined();
		expect(snapshot.tables.map((table) => table.rows.map((row) => row.label))).toEqual([['Open A', 'Open C'], ['Done B']]);
		expect(snapshot.texts).toEqual(expect.arrayContaining(['Open', 'Done']));
		const [open, done] = snapshot.tables;
		expect(open!.rows[0]!.actions).toMatchObject([{ id: 'close', label: 'Done →', available: true, action: { capability: 'items.close', input: { id: 1 } } }]);
		// Cards in Done have no move out of it.
		expect(done!.rows[0]!.actions).toEqual([]);

		const clerk = snapshotA2UI(build, { data: { items: { items } }, slot: {}, can: () => false }, {}, host);
		expect(clerk.tables[0]!.rows[0]!.actions[0]!.available).toBe(false);
	});

	it('says when a column is empty', async () => {
		const snapshot = snapshotA2UI(await boardBuild(), { data: { items: { items: [items[0]] } }, slot: {}, can: () => true }, {}, host);
		expect(snapshot.texts).toContain('Nothing done');
		expect(snapshot.texts).not.toContain('Nothing open');
	});

	it('passes frozen checks through the verifier, and fails the one a mistake breaks', async () => {
		const good = await verifyBuild({ build: (await boardBuild()) as unknown as Build, spec, surface, sandbox: fakeSandbox(), createCan });
		expect(good.results.filter((r) => !r.passed)).toEqual([]);

		const everyone = await boardBuild((component) => {
			delete (component.moves as Array<Record<string, unknown>>)[0]!.visible;
		});
		const broken = await verifyBuild({ build: everyone as unknown as Build, spec, surface, sandbox: fakeSandbox(), createCan });
		expect(broken.results.filter((r) => !r.passed).map((r) => [r.criterion, r.failures])).toEqual([['clerks', ['Expected "close" not to be available for title "Open A", but it is.']]]);
	});

	it('validates, with its props in the refs', async () => {
		const build = await boardBuild();
		expect((await validateBuild(build as unknown as Build, surface)).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
		expect((build as unknown as Build).refs.catalog).toEqual({ Board: ['columnBy', 'columns', 'fields', 'items', 'moves'], Column: ['children'] });
	});

	it('refuses moves to or from no column, ambiguous drops, dotted pointers, and hosts without a board', async () => {
		const build = await boardBuild((component) => {
			component.columnBy = 'meta.lane';
			const moves = component.moves as Array<Record<string, unknown>>;
			moves.push({ ...moves[0], id: 'again' });
			moves.push({ ...moves[0], id: 'nowhere', to: 'archived' });
			moves.push({ ...moves[0], id: 'stay', to: 'open' });
			(component.columns as unknown[]).push({ id: 'open', title: 'Open again' });
		});
		const codes = validateA2UI(build as unknown as Build, surface, host).map((d) => `${d.code} ${d.path}`);
		expect(codes).toEqual([
			'a2ui-board /ui/components/1/columnBy',
			'a2ui-board /ui/components/1/columns/2/id',
			'a2ui-board /ui/components/1/moves/1',
			'a2ui-board /ui/components/1/moves/2/to',
			'a2ui-board /ui/components/1/moves/3',
		]);

		const withoutBoard = validateA2UI((await boardBuild()) as unknown as Build, surface, { catalogId: 'graft:board' });
		expect(withoutBoard.map((d) => d.code)).toContain('a2ui-unknown-component');
	});
});
