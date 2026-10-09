import {
	extractRefs,
	hashSpec,
	hashSurface,
	SandboxCallError,
	validateSpec,
	registerUiFormat,
	type Build,
	type Sandbox,
	type Surface,
} from '../../src/index.ts';
import { createA2UIFormat } from '../../../a2ui/src/index.ts';

/**
 * A tiny fake host ("acme") for verifier and compiler tests: items with
 * statuses that managers may close.
 */

export const surface: Surface = {
	graft: 1,
	host: 'acme',
	hostVersion: '1.0',
	slots: {
		page: { kind: 'owned', title: 'Page' },
		'item.actions': { kind: 'extension', title: 'Item actions', provides: { type: 'object', properties: { item: {} } } },
	},
	capabilities: {
		'items.list': { kind: 'read', input: {}, output: {}, scopes: ['items:read'] },
		'items.close': { kind: 'write', input: {}, output: {}, scopes: ['items:write'] },
	},
	scopes: { 'items:read': { title: 'See items' }, 'items:write': { title: 'Close items' } },
};

/** Acme draws A2UI surfaces from its own catalog. */
export const format = createA2UIFormat({ host: 'acme', catalogId: 'graft:acme' });
registerUiFormat(format);

export interface FakeHostOptions {
	/** Capability names of the new host mapped to the ones this host implements. */
	aliases?: Record<string, string>;
	/** Slots that render like "item.actions". */
	itemSlots?: string[];
	/** Name of the status filter in the items.list input. */
	statusKey?: string;
}

/** An in-memory host: items with statuses; only managers may close them. */
export function fakeSandbox({ aliases = {}, itemSlots = ['item.actions'], statusKey = 'status' }: FakeHostOptions = {}): Sandbox & { calls: string[] } {
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
		async call(user, name, input) {
			calls.push(`${user} ${name}`);
			const capability = aliases[name] ?? name;
			if (capability === 'items.list') {
				const status = (input as Record<string, string> | null)?.[statusKey];
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
			if (slot === 'page') {
				return [{}];
			}
			return itemSlots.includes(slot) ? items.map((item) => ({ item })) : [];
		},
		async assert(kind, expected) {
			const e = expected as { title: string; status: string };
			const item = items.find((i) => i.title === e.title);
			return { ok: kind === 'item' && item?.status === e.status, actual: item ?? null };
		},
	};
}

export const specSource = `---
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
export const spec = validateSpec(specSource).spec!;

export const fixtures = {
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

export const createCan = (usable: Record<string, boolean>) => (scope: string) => usable[scope] === true;

/** The page build for the spec: an A2UI table of open items with a Close action. */
export async function pageBuild(input: Build['data'][string]['input'] = { status: 'open' }): Promise<Build> {
	const build: Build = {
		graft: 1,
		spec: { id: 'open-items', hash: await hashSpec(specSource) },
		surface: { host: 'acme', hostVersion: '1.0', hash: await hashSurface(surface) },
		mount: { slot: 'page' },
		data: { open: { call: 'items.list', input } },
		ui: {
			protocol: 'a2ui/v0.9',
			catalogId: 'graft:acme',
			components: [
				{ id: 'root', component: 'Column', children: ['title', 'list'] },
				{ id: 'title', component: 'Text', text: 'Open items', variant: 'h1' },
				{
					id: 'list',
					component: 'Table',
					rows: { path: '/open/items' },
					fields: [{ id: 'title', label: 'Title', primary: true }],
					rowActions: [
						{ id: 'close', label: 'Close', visible: { call: 'can', args: { scope: 'items:write' } }, action: { event: { name: 'close', context: { id: { path: 'id' } } } } },
					],
					empty: 'All done',
				},
			],
		},
		events: { close: { call: 'items.close', input: { id: { $context: 'id' } }, then: ['remove-row:open'] } },
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
		refs: { slot: 'page', capabilities: [], scopes: [], catalog: {} },
		provenance: { compiler: 'test' },
	};
	build.refs = extractRefs(build, surface);
	return build;
}
