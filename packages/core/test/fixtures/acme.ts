import { SandboxCallError, validateSpec, type ComponentSemantics, type Sandbox, type Surface } from '../../src/index.ts';

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
export const semantics: ComponentSemantics = {
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
export function fakeSandbox(): Sandbox & { calls: string[] } {
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
