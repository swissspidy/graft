import { validateBuild, type Build } from '@graft/core';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { findAction, readValue, withState, type Block } from '../src/host/blocks.ts';
import { createCan } from '../src/host/can.ts';
import { nextA2UIState, renderA2UI } from '../src/host/a2ui.ts';

const entry = (id: string, title: string, publish: boolean) => ({ id, collection: 'posts', title, status: 'draft', author: { id: 'u1', name: 'Ada' }, can: { publish } });

const publish = { id: 'publish', label: 'Publish', variant: 'primary', visible: { call: 'can', args: { scope: 'content.status:write' } }, action: { event: { name: 'publish', context: { id: { path: 'id' } } } } };

/** A queue with a publish button per row, and buttons that pick which author's entries to show. */
const build = {
	graft: 1,
	spec: { id: 'queue', hash: 'sha256:x' },
	surface: { host: 'emdash', hash: 'sha256:y' },
	mount: { slot: 'admin.page', title: 'Queue' },
	data: { q: { call: 'content.list', input: { collection: 'posts' } } },
	ui: {
		protocol: 'a2ui/v0.9',
		catalogId: 'graft:emdash',
		components: [
			{ id: 'root', component: 'Column', children: ['title', 'pick', 'table'] },
			{ id: 'title', component: 'Text', text: 'Queue', variant: 'h1' },
			{ id: 'pick', component: 'Row', children: ['ada', 'everyone'] },
			{ id: 'ada', component: 'Button', child: 'ada-label', action: { functionCall: { call: 'set', args: { target: '/form/author', value: 'Ada' } } } },
			{ id: 'ada-label', component: 'Text', text: 'Ada' },
			{ id: 'everyone', component: 'Button', child: 'everyone-label', action: { functionCall: { call: 'set', args: { target: '/form/author', value: '' } } } },
			{ id: 'everyone-label', component: 'Text', text: 'Everyone' },
			{
				id: 'table',
				component: 'Table',
				rows: { path: '/q/items' },
				fields: [
					{ id: 'title', label: 'Title', primary: true },
					{ id: 'author/name', label: 'Author' },
				],
				rowActions: [publish],
				empty: 'Nothing waiting',
			},
		],
	},
	events: { publish: { call: 'content.publish', input: { collection: 'posts', id: { $context: 'id' } }, then: ['refresh:q'], notice: 'Done.' } },
	checks: [],
	refs: { slot: 'admin.page', capabilities: [], scopes: [], catalog: {} },
	provenance: { compiler: 'test' },
} as unknown as Build;

const ctx = (items: unknown[], usable: Record<string, boolean>) => ({ data: { q: { items } }, slot: {}, can: createCan(usable) });
const both = () => ctx([entry('a', 'Draft A', true), entry('b', 'Draft B', false)], { 'content.status:write': true });

describe('renderA2UI', () => {
	it('translates text, rows of buttons and a table with per-row buttons into Block Kit', () => {
		const rendered = renderA2UI(build, both(), 'queue');
		expect(rendered.blocks[0]).toEqual({ type: 'header', text: 'Queue' });
		expect(rendered.blocks[1]).toEqual({
			type: 'actions',
			elements: [
				{ type: 'button', action_id: 'queue:b0', label: 'Ada' },
				{ type: 'button', action_id: 'queue:b1', label: 'Everyone' },
			],
		});
		const table = rendered.blocks[2]!;
		expect(table.columns).toEqual([
			{ key: 'c0', label: 'Title' },
			{ key: 'c1', label: 'Author' },
			{ key: 'queue:t2:0', label: '', format: 'element' },
		]);
		const rows = table.rows as Array<Record<string, unknown>>;
		expect(rows[0]).toEqual({ c0: 'Draft A', c1: 'Ada', 'queue:t2:0': { type: 'button', action_id: 'queue:t2:0', label: 'Publish', style: 'primary', value: 'a' } });
		// The entry's own flags refine can: no button on B.
		expect(rows[1]).toEqual({ c0: 'Draft B', c1: 'Ada' });
		expect(table.empty_text).toBe('Nothing waiting');
	});

	it('resolves a click only to an action the fresh render still offers', () => {
		const rendered = renderA2UI(build, both(), 'queue');
		expect(findAction(rendered, 'queue:t2:0', 'a')?.action).toMatchObject({ capability: 'content.publish', input: { collection: 'posts', id: 'a' }, notice: 'Done.' });
		expect(findAction(rendered, 'queue:t2:0', 'b')).toBeUndefined();
		expect(findAction(rendered, 'queue:t2:0', 'zzz')).toBeUndefined();
		expect(findAction(rendered, 'other:t2:0', 'a')).toBeUndefined();
	});

	it('hides buttons when the scope is not usable', () => {
		const rendered = renderA2UI(build, ctx([entry('a', 'Draft A', true)], {}), 'queue');
		expect((rendered.blocks[2]!.rows as Array<Record<string, unknown>>)[0]).toEqual({ c0: 'Draft A', c1: 'Ada' });
		expect(rendered.actions.filter((a) => a.id === 'publish').every((a) => !a.available)).toBe(true);
	});
});

describe('local state', () => {
	const buttons = (item: unknown): Block[] =>
		Array.isArray(item) ? item.flatMap(buttons) : typeof item === 'object' && item !== null ? ((item as Block).type === 'button' ? [item as Block] : Object.values(item).flatMap(buttons)) : [];

	it('rides in every button of the customization, and comes back with a click', () => {
		const rendered = withState(renderA2UI(build, both(), 'queue', { '/form/author': 'Ada' }), 'queue');
		const all = buttons(rendered.blocks);
		expect(all.length).toBeGreaterThan(0);
		const publishA = all.find((b) => b.action_id === 'queue:t2:0')!;
		expect(readValue(publishA.value)).toEqual({ value: 'a', state: { '/form/author': 'Ada' } });
		expect(readValue('a')).toEqual({ value: 'a', state: {} });
		expect(readValue('w|not json')).toEqual({ value: 'w|not json', state: {} });
	});

	it('changes with a local action, latest last, and nothing is called', () => {
		const rendered = renderA2UI(build, both(), 'queue', { '/form/author': 'Ada' });
		const everyone = findAction(rendered, 'queue:b1', undefined)!;
		expect(everyone.action).toBeUndefined();
		expect(everyone.event).toMatchObject({ name: '/form/author', payload: '' });
		expect(nextA2UIState({ '/form/author': 'Ada', '/x': 1 }, everyone.event!)).toEqual({ '/x': 1, '/form/author': '' });
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
