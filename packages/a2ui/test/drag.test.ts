import { describe, expect, it } from 'vitest';
import { extractRefs, validateBuild, verifyBuild, type Build } from '@swissspidy/graft-core';
import { createCan, fakeSandbox, fixtures, pageBuild, spec, surface } from '../../core/test/fixtures/acme.ts';
import { snapshotA2UI, validateA2UI, type A2UIBuild, type A2UIHost } from '../src/index.ts';

const host: A2UIHost = { catalogId: 'graft:acme' };

/** Acme items on a board: an Open and a Done column, cards that a manager drags to Done. */
async function boardBuild(change?: (build: A2UIBuild) => void): Promise<Build> {
	const build = (await pageBuild({})) as unknown as A2UIBuild;
	build.data = { items: { call: 'items.list', input: {} } };
	build.ui = {
		protocol: 'a2ui/v0.9',
		catalogId: 'graft:acme',
		computed: {
			open: { call: 'filter', args: { items: { path: '/items/items' }, by: 'status', equals: 'open' } },
			done: { call: 'filter', args: { items: { path: '/items/items' }, by: 'status', equals: 'done' } },
		},
		components: [
			{ id: 'root', component: 'Row', children: ['open-lane', 'done-lane'] },
			{ id: 'open-lane', component: 'Column', dropTarget: 'open', children: ['open-title', 'open-cards'] },
			{ id: 'open-title', component: 'Text', text: 'Open', variant: 'h3' },
			{ id: 'open-cards', component: 'Column', children: { componentId: 'card', path: '/open' } },
			{ id: 'done-lane', component: 'Column', dropTarget: 'done', children: ['done-title', 'done-cards'] },
			{ id: 'done-title', component: 'Text', text: 'Done', variant: 'h3' },
			{ id: 'done-cards', component: 'Column', children: { componentId: 'card', path: '/done' } },
			{ id: 'card', component: 'Card', draggable: true, child: 'card-body' },
			{ id: 'card-body', component: 'Column', children: ['card-title', 'card-status', 'close'] },
			{ id: 'card-title', component: 'Text', text: { path: 'title' } },
			{ id: 'card-status', component: 'Text', text: { path: 'status' } },
			{
				id: 'close',
				component: 'Button',
				child: 'close-label',
				dropTarget: 'done',
				visible: { call: 'and', args: { values: [{ call: 'equals', args: { a: { path: 'status' }, b: 'open' } }, { call: 'can', args: { scope: 'items:write' } }] } },
				action: { event: { name: 'close', context: { id: { path: 'id' } } } },
			},
			{ id: 'close-label', component: 'Text', text: 'Done →' },
		],
	};
	build.events = { close: { call: 'items.close', input: { id: { $context: 'id' } }, then: ['refresh:items'] } };
	build.checks = [
		{ criterion: 'open-only', fixtures, view_as: 'm', expect: [{ rows: ['Open A'], in: 'open' }, { rows: ['Done B'], in: 'done' }, { cell: { row: { title: 'Done B' }, column: 'card-status', text: 'done' } }] },
		{ criterion: 'close', fixtures, view_as: 'm', steps: [{ drop: { title: 'Open A' }, on: 'done' }], expect: [{ rows: [], in: 'open' }, { rows: ['Open A', 'Done B'], in: 'done' }, { item: { title: 'Open A', status: 'done' } }] },
		{ criterion: 'clerks', fixtures, view_as: 'c', expect: [{ action: 'close', row: { title: 'Open A' }, available: false }] },
		// The button is hidden from a clerk, and the host refuses it when called anyway.
		{ criterion: 'clerks', fixtures, view_as: 'c', steps: [{ action: 'close', row: { title: 'Open A' }, direct: true }], expect: [{ refused: 'close', row: { title: 'Open A' } }, { rows: ['Open A'], in: 'open' }] },
		{ criterion: 'empty', fixtures: { ...fixtures, items: [] }, view_as: 'm', expect: [{ rows: [] }, { rows: [], in: 'done' }] },
	];
	change?.(build);
	const result = build as unknown as Build;
	result.refs = extractRefs(result, surface);
	return result;
}

const items = [
	{ id: 1, title: 'Open A', status: 'open' },
	{ id: 2, title: 'Done B', status: 'done' },
];

describe('cards and dragging', () => {
	it('read a template of Cards as rows in the zone they are drawn in: first text, Texts by id, Buttons with their drop targets', async () => {
		const build = (await boardBuild()) as unknown as A2UIBuild;
		const snapshot = snapshotA2UI(build, { data: { items: { items } }, slot: {}, can: () => true }, {}, host);
		expect(snapshot.problems).toBeUndefined();
		expect(snapshot.tables.map((table) => [table.zone, table.rows.map((row) => row.label)])).toEqual([
			['open', ['Open A']],
			['done', ['Done B']],
		]);
		const [open, done] = snapshot.tables;
		expect(open!.rows[0]!.cells).toEqual({ 'card-title': { text: 'Open A' }, 'card-status': { text: 'open' } });
		expect(open!.rows[0]!.actions).toMatchObject([{ id: 'close', label: 'Done →', available: true, dropTarget: 'done', row: items[0], action: { capability: 'items.close', input: { id: 1 } } }]);
		// Hidden on cards already done: there, but not available (a direct call can still name it).
		expect(done!.rows[0]!.actions).toMatchObject([{ id: 'close', available: false }]);
		// Headings are texts; card texts are the rows'.
		expect(snapshot.texts).toEqual(['Open', 'Open A', 'open', 'Done →', 'Done', 'Done B', 'done']);
	});

	it('pass frozen checks that drop cards, and fail the one a mistake breaks', async () => {
		const good = await verifyBuild({ build: await boardBuild(), spec, surface, sandbox: fakeSandbox(), createCan });
		expect(good.results.filter((r) => !r.passed)).toEqual([]);

		const everyone = await boardBuild((b) => {
			b.ui.components.find((c) => c.id === 'close')!.visible = { call: 'equals', args: { a: { path: 'status' }, b: 'open' } };
		});
		const broken = await verifyBuild({ build: everyone, spec, surface, sandbox: fakeSandbox(), createCan });
		expect(broken.results.filter((r) => !r.passed).map((r) => [r.criterion, r.failures])).toEqual([['clerks', ['Expected "close" not to be available for title "Open A", but it is.']]]);
	});

	it('refuse a drop where the card has no button the viewer can use', async () => {
		const build = await boardBuild((b) => {
			b.checks = [
				{ criterion: 'clerks', fixtures, view_as: 'c', steps: [{ drop: { title: 'Open A' }, on: 'done' }], expect: [{ rows: [] }] },
				{ criterion: 'clerks', fixtures, view_as: 'm', steps: [{ drop: { title: 'Open A' }, on: 'open' }], expect: [{ rows: [] }] },
			];
		});
		const result = await verifyBuild({ build, spec, surface, sandbox: fakeSandbox(), createCan });
		expect(result.results.map((r) => r.failures)).toEqual([['Step 1: title "Open A" cannot be dropped on "done".'], ['Step 1: title "Open A" cannot be dropped on "open".']]);
	});

	it('validate, with the drag props in the refs', async () => {
		const build = await boardBuild();
		expect((await validateBuild(build, surface)).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
		expect(build.refs.catalog).toMatchObject({ Button: ['action', 'child', 'dropTarget', 'visible'], Card: ['child', 'draggable'], Column: ['children', 'dropTarget'] });
	});

	it('refuse drop buttons outside a draggable card or aimed nowhere, and draggable cards with nothing to press', async () => {
		const build = await boardBuild((b) => {
			const byId = (id: string) => b.ui.components.find((c) => c.id === id)!;
			byId('close').dropTarget = 'archive';
			(byId('root').children as string[]).push('loose');
			b.ui.components.push({ id: 'loose', component: 'Button', child: 'close-label', dropTarget: 'done', action: { event: { name: 'close', context: {} } } });
			(byId('open-lane').children as string[]).push('sticky');
			b.ui.components.push({ id: 'sticky', component: 'Card', draggable: true, child: 'open-title' });
		});
		expect(validateA2UI(build, surface, host).map((d) => `${d.code} ${d.path} ${d.message}`)).toEqual([
			'a2ui-drag /ui/components/11/dropTarget The button "close" is pressed by a drop on "archive", but no Column, Row or Card has that "dropTarget" (open, done).',
			'a2ui-drag /ui/components/13/dropTarget The button "loose" has a "dropTarget" but is not inside a Card with "draggable": nothing is dragged to press it.',
			'a2ui-drag /ui/components/14/draggable The card "sticky" is draggable but has no Button with a "dropTarget": dropping it would do nothing.',
		]);
	});
});
