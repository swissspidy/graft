import { describe, expect, it } from 'vitest';
import { extractRefs, hashSpec, hashSurface, validateSpec, verifyBuild, type Build } from '../src/index.ts';
import { createCan, fakeSandbox, fixtures, semantics, spec, specSource, surface } from './fixtures/acme.ts';

async function pageBuild(input: Build['data'][string]['input'] = { status: 'open' }): Promise<Build> {
	const build: Build = {
		graft: 1,
		spec: { id: 'open-items', hash: await hashSpec(specSource) },
		surface: { host: 'acme', hash: await hashSurface(surface) },
		mount: { slot: 'page' },
		data: { open: { call: 'items.list', input } },
		tree: {
			type: 'stack',
			children: [
				{ type: 'text', children: 'Open items' },
				{
					type: 'list',
					props: {
						rows: { $data: 'open.items' },
						empty: 'All done',
						actions: [
							{
								id: 'close',
								label: 'Close',
								visible: { $can: 'items:write' },
								onClick: { $call: 'items.close', input: { id: { $field: 'id' } }, then: ['remove-row:open'] },
							},
						],
					},
				},
			],
		},
		checks: [
			{ criterion: 'open-only', fixtures, view_as: 'm', expect: [{ rows: ['Open A'] }, { columns: ['Title'] }, { text: 'Open items' }] },
			{
				criterion: 'close',
				fixtures,
				view_as: 'm',
				steps: [{ action: 'close', row: { title: 'Open A' } }],
				expect: [{ rows: [] }, { text: 'All done' }, { item: { title: 'Open A', status: 'done' } }],
			},
			{ criterion: 'clerks', fixtures, view_as: 'c', expect: [{ rows: ['Open A'] }, { action: 'close', row: { title: 'Open A' }, available: false }] },
			{ criterion: 'empty', fixtures: { ...fixtures, items: [] }, view_as: 'm', expect: [{ text: 'All done' }] },
		],
		refs: { slot: 'page', components: {}, capabilities: [], scopes: [] },
		provenance: { compiler: 'test' },
	};
	build.refs = extractRefs(build, surface);
	return build;
}


describe('verifyBuild', () => {
	it('passes a build that meets its criteria', async () => {
		const sandbox = fakeSandbox();
		const result = await verifyBuild({ build: await pageBuild(), spec, surface, sandbox, semantics, createCan });
		expect(result.results.filter((r) => !r.passed)).toEqual([]);
		expect(result.passed).toBe(true);
		expect(result.unchecked).toEqual([]);
		expect(sandbox.calls).toContain('m items.close');
	});

	it('explains which criteria a wrong build breaks', async () => {
		const result = await verifyBuild({ build: await pageBuild({}), spec, surface, sandbox: fakeSandbox(), semantics, createCan });
		expect(result.passed).toBe(false);
		const failed = Object.fromEntries(result.results.filter((r) => !r.passed).map((r) => [r.criterion, r.failures]));
		expect(failed).toEqual({
			'open-only': ['Expected rows "Open A", found "Open A", "Done B".'],
			close: ['Expected rows (none), found "Done B".', 'Expected the text "All done" to be shown.'],
			clerks: ['Expected rows "Open A", found "Open A", "Done B".'],
		});
	});

	it('reports steps the host refuses and actions that are missing', async () => {
		const build = await pageBuild();
		build.checks = [
			{ criterion: 'close', fixtures, view_as: 'c', steps: [{ action: 'close', row: { title: 'Open A' } }], expect: [{ rows: [] }] },
			{ criterion: 'clerks', fixtures, view_as: 'm', steps: [{ action: 'close', row: { title: 'Nope' } }], expect: [{ rows: [] }] },
		];
		// Make the action visible to everyone so the host has to refuse it.
		const list = (build.tree.children as Build['tree'][])[1]!;
		(list.props!.actions as Array<Record<string, unknown>>)[0]!.visible = true;
		build.refs = extractRefs(build, surface);
		const result = await verifyBuild({ build, spec, surface, sandbox: fakeSandbox(), semantics, createCan });
		expect(result.results.map((r) => r.failures)).toEqual([
			['Step 1: "close" was refused: Only managers may close items (forbidden).'],
			['Step 1: no available "close" action for title "Nope".'],
		]);
		expect(result.unchecked).toEqual(['open-only', 'empty']);
	});

	it('renders nothing for users outside the audience', async () => {
		const build = await pageBuild();
		build.checks = [{ criterion: 'open-only', fixtures, view_as: 'x', expect: [{ rows: [] }, { text: 'Open items' }] }];
		const result = await verifyBuild({ build, spec, surface, sandbox: fakeSandbox(), semantics, createCan });
		expect(result.results[0]!.failures).toEqual(['Expected the text "Open items" to be shown.']);
	});

	it('renders extension slots once per instance and binds actions to it', async () => {
		const build = await pageBuild();
		build.mount = { slot: 'item.actions' };
		build.data = {};
		build.tree = {
			type: 'link',
			props: {
				id: 'close',
				label: 'Close',
				visible: { $and: [{ $eq: [{ $slot: 'item.status' }, 'open'] }, { $can: 'items:write' }] },
				onClick: { $call: 'items.close', input: { id: { $slot: 'item.id' } }, then: ['reload:page'] },
			},
		};
		build.checks = [
			{
				criterion: 'close',
				fixtures,
				view_as: 'm',
				expect: [
					{ action: 'close', row: { title: 'Open A' } },
					{ action: 'close', row: { title: 'Done B' }, available: false },
				],
			},
			{
				criterion: 'open-only',
				fixtures,
				view_as: 'm',
				steps: [{ action: 'close', row: { title: 'Open A' } }],
				expect: [{ item: { title: 'Open A', status: 'done' } }, { action: 'close', available: false }],
			},
		];
		build.refs = extractRefs(build, surface);
		const result = await verifyBuild({ build, spec, surface, sandbox: fakeSandbox(), semantics, createCan });
		expect(result.results.flatMap((r) => r.failures)).toEqual([]);
	});

	it('refuses capabilities outside the build or the requested permissions', async () => {
		const narrow = validateSpec(specSource.replace('[items:read, items:write]', '[items:read]')).spec!;
		const build = await pageBuild();
		build.checks = [build.checks[1]!];
		const result = await verifyBuild({ build, spec: narrow, surface, sandbox: fakeSandbox(), semantics, createCan: () => () => true });
		expect(result.results[0]!.failures[0]).toContain('(graft_not_granted)');
	});
});
