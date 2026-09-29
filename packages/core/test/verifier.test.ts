import { describe, expect, it } from 'vitest';
import {
	extractRefs,
	hashSpec,
	hashSurface,
	SandboxCallError,
	validateSpec,
	verifyBuild,
	type Build,
	type ComponentSemantics,
	type Sandbox,
	type Surface,
} from '../src/index.ts';

const surface: Surface = {
	graft: 1,
	host: 'acme',
	hostVersion: '1.0',
	slots: {
		page: { kind: 'owned', title: 'Page' },
		'item.actions': { kind: 'extension', title: 'Item actions', provides: { type: 'object', properties: { item: {} } } },
	},
	components: {
		stack: { props: {}, children: 'any' },
		text: { props: {}, children: 'text' },
		list: { props: {} },
		link: { props: {} },
	},
	capabilities: {
		'items.list': { kind: 'read', input: {}, output: {}, scopes: ['items:read'] },
		'items.close': { kind: 'write', input: {}, output: {}, scopes: ['items:write'] },
	},
	scopes: { 'items:read': { title: 'See items' }, 'items:write': { title: 'Close items' } },
};

/** Semantics a host adapter would provide for these components. */
const semantics: ComponentSemantics = {
	list: ({ props, raw, evaluate, emit }) => {
		const rows = (props.rows as Array<{ id: number; title: string }> | undefined) ?? [];
		emit.table({
			columns: ['Title'],
			rows: rows.map((row) => ({
				label: row.title,
				record: row,
				actions: ((raw.actions ?? []) as never[]).map((a) => {
					const action = evaluate(a, row) as { id: string; label: string; visible?: unknown; onClick: never };
					return { id: action.id, label: action.label, available: action.visible !== false, action: action.onClick, row };
				}),
			})),
		});
		if (rows.length === 0 && typeof props.empty === 'string') {
			emit.text(props.empty);
		}
	},
	link: ({ props, emit }) => {
		emit.action({ id: String(props.id), label: String(props.label), available: props.visible !== false, action: props.onClick as never });
	},
};

/** An in-memory host: items with statuses; only managers may close them. */
function fakeSandbox(): Sandbox & { calls: string[] } {
	let users: Record<string, string[]> = {};
	let items: Array<{ id: number; title: string; status: string }> = [];
	const calls: string[] = [];
	return {
		calls,
		async reset() {
			users = {};
			items = [];
		},
		async seed(fixtures) {
			const f = fixtures as { users?: Array<{ as: string; role: string }>; items?: Array<{ title: string; status: string }> };
			users = Object.fromEntries((f.users ?? []).map((u) => [u.as, [u.role]]));
			items = (f.items ?? []).map((item, i) => ({ id: i + 1, ...item }));
			return { users };
		},
		async scopes(user, scopes) {
			return Object.fromEntries(scopes.map((s) => [s, s === 'items:read' || users[user]?.includes('manager') === true]));
		},
		async call(user, capability, input) {
			calls.push(`${user} ${capability}`);
			if (capability === 'items.list') {
				const status = (input as { status?: string } | null)?.status;
				return { items: items.filter((item) => !status || item.status === status) };
			}
			if (!users[user]?.includes('manager')) {
				throw new SandboxCallError('forbidden', 'Only managers may close items');
			}
			const item = items.find((i) => i.id === (input as { id: number }).id)!;
			item.status = 'done';
			return item;
		},
		async slotInstances(_user, slot) {
			return slot === 'page' ? [{}] : items.map((item) => ({ item }));
		},
		async assert(kind, expected) {
			const e = expected as { title: string; status: string };
			const item = items.find((i) => i.title === e.title);
			return { ok: kind === 'item' && item?.status === e.status, actual: item ?? null };
		},
	};
}

const specSource = `---
graft: 1
id: open-items
host: acme
mount: { slot: page }
audience: [manager, clerk]
permissions: [items:read, items:write]
---

# Open items

Managers close open items.

## Acceptance criteria

- Only open items are listed {#open-only}
- "Close" closes the item and removes it {#close}
- Clerks cannot close {#clerks}
- When nothing is open, say so {#empty}
`;
const spec = validateSpec(specSource).spec!;

const fixtures = {
	users: [
		{ as: 'm', role: 'manager' },
		{ as: 'c', role: 'clerk' },
		{ as: 'x', role: 'visitor' },
	],
	items: [
		{ title: 'Open A', status: 'open' },
		{ title: 'Done B', status: 'done' },
	],
};

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

const createCan = (usable: Record<string, boolean>) => (scope: string) => usable[scope] === true;

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
