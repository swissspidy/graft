import { describe, expect, it } from 'vitest';
import {
	evaluate,
	extractRefs,
	hashSpec,
	hashSurface,
	validateBuild,
	validateSpec,
	type Build,
	type EvalContext,
	type Surface,
} from '../src/index.ts';
import './fixtures/acme.ts';

const surface: Surface = {
	graft: 1,
	host: 'acme',
	hostVersion: '1.0',
	slots: {
		page: { kind: 'owned', title: 'Page' },
		'row.actions': {
			kind: 'extension',
			title: 'Row actions',
			provides: { type: 'object', properties: { item: { type: 'object' } } },
		},
	},
	capabilities: {
		'items.list': {
			kind: 'read',
			input: { type: 'object', properties: { status: { enum: ['open', 'done'] } }, additionalProperties: false },
			output: { type: 'object' },
			scopes: ['items:read'],
		},
		'items.close': {
			kind: 'write',
			input: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
			output: { type: 'object' },
			scopes: ['items:write'],
		},
	},
	scopes: { 'items:read': { title: 'See items' }, 'items:write': { title: 'Change items' } },
};

const specSource = `---
graft: 1
id: open-items
host: acme
mount: { slot: page }
permissions: [items:read, items:write]
---

# Open items

Shows open items and closes them.

## Acceptance criteria

- Only open items are listed {#open-only}
- "Close" closes the item {#close}
`;

async function build(): Promise<Build> {
	const b: Build = {
		graft: 1,
		spec: { id: 'open-items', hash: await hashSpec(specSource) },
		surface: { host: 'acme', hash: await hashSurface(surface) },
		mount: { slot: 'page' },
		data: { items: { call: 'items.list', input: { status: 'open' } } },
		ui: {
			protocol: 'a2ui/v0.9',
			catalogId: 'graft:acme',
			components: [
				{ id: 'root', component: 'Column', children: ['title', 'list'] },
				{ id: 'title', component: 'Text', text: 'Open items' },
				{
					id: 'list',
					component: 'Table',
					rows: { path: '/items/items' },
					fields: [{ id: 'title', label: 'Title', primary: true }],
					rowActions: [
						{ id: 'close', label: 'Close', visible: { call: 'can', args: { scope: 'items:write' } }, action: { event: { name: 'close', context: { id: { path: 'id' } } } } },
					],
					empty: 'Nothing open',
				},
			],
		},
		events: { close: { call: 'items.close', input: { id: { $context: 'id' } }, then: ['remove-row:items'], notice: 'Closed.' } },
		checks: [
			{ criterion: 'open-only', expect: [{ rows: 1 }] },
			{ criterion: 'close', expect: [{ action: 'close' }] },
		],
		refs: { slot: 'page', capabilities: [], scopes: [], catalog: {} },
		provenance: { compiler: 'handwritten', strategy: 'handwritten' },
	};
	b.refs = extractRefs(b, surface);
	return b;
}

const spec = validateSpec(specSource).spec!;

describe('extractRefs', () => {
	it('collects catalog components with properties, capabilities and scopes', async () => {
		expect((await build()).refs).toEqual({
			slot: 'page',
			capabilities: ['items.close', 'items.list'],
			scopes: ['items:read', 'items:write'],
			catalog: { Column: ['children'], Table: ['empty', 'fields', 'rowActions', 'rows'], Text: ['text'] },
		});
	});
});

describe('validateBuild', () => {
	it('accepts a consistent build', async () => {
		const result = await validateBuild(await build(), surface, { spec: { spec, hash: await hashSpec(specSource) } });
		expect(result.diagnostics).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it('refuses a build when no UI format handles it', async () => {
		const result = await validateBuild({ ...(await build()), ui: { protocol: 'other/1', catalogId: 'x' }, events: {} }, surface);
		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => d.code)).toEqual(['build-unknown-format']);
	});

	it('rejects stored refs that do not match the content', async () => {
		const b = await build();
		b.refs.scopes = ['items:read'];
		expect((await validateBuild(b, surface)).diagnostics.map((d) => d.code)).toEqual(['build-refs-mismatch']);
	});

	it('reports unknown components, bad inputs and data sources', async () => {
		const b = await build();
		(b.ui.components as Array<Record<string, unknown>>).push({ id: 'chart', component: 'Chart' });
		b.events.close = { call: 'items.close', input: { id: 'seven' }, then: ['refresh:elsewhere'] };
		b.data.items!.input = { status: 'closed' };
		b.data.more = { call: 'items.close', input: { id: { $data: 'items.first' } } };
		b.refs = extractRefs(b, surface);
		const codes = (await validateBuild(b, surface)).diagnostics.map((d) => `${d.code} ${d.path}`);
		expect(codes).toEqual([
			'a2ui-unreachable /ui/components',
			'a2ui-unknown-component /ui/components/3/component',
			'build-invalid-value /events/close/input',
			'build-unknown-data /events/close/then/0',
			'build-invalid-value /data/items/input/status',
			'build-data-not-read /data/more/call',
		]);
	});

	it('checks the slot and target surface', async () => {
		const b = await build();
		b.mount.slot = 'row.actions';
		b.surface.hash = 'sha256:other';
		b.refs = extractRefs(b, surface);
		expect((await validateBuild(b, surface)).diagnostics.map((d) => d.code)).toEqual(['build-surface-mismatch']);
	});

	it('checks the build against its spec', async () => {
		const b = await build();
		b.checks = [{ criterion: 'open-only', expect: [{ rows: 1 }] }, { criterion: 'typo', expect: [{ x: 1 }] }];
		const narrow = validateSpec(specSource.replace('[items:read, items:write]', '[items:read]')).spec!;
		const result = await validateBuild(b, surface, { spec: { spec: narrow, hash: 'sha256:stale' } });
		expect(result.diagnostics.map((d) => d.code)).toEqual([
			'build-spec-mismatch',
			'build-scope-not-requested',
			'build-unknown-criterion',
			'build-criterion-unchecked',
		]);
	});

	it('rejects malformed builds', async () => {
		expect((await validateBuild({ graft: 1 }, surface)).diagnostics[0]?.code).toBe('build-schema');
	});
});

describe('evaluate', () => {
	const ctx: EvalContext = {
		data: { items: { items: [{ id: 7, title: 'A' }] } },
		slot: { item: { id: 3, owner: { name: 'Ada' } }, other: { id: 7 } },
		can: (scope, on) => scope === 'items:write' && (on as { id: number } | undefined)?.id === 7,
	};

	it('resolves bindings and permission checks', () => {
		expect(evaluate({ $data: 'items.items.0.title' }, ctx)).toBe('A');
		expect(evaluate({ $slot: 'item.owner.name' }, ctx)).toBe('Ada');
		expect(evaluate({ $slot: 'item.id' }, ctx)).toBe(3);
		expect(evaluate({ $data: 'missing.path' }, ctx)).toBeUndefined();
		expect(evaluate({ $can: 'items:write' }, ctx)).toBe(false);
		expect(evaluate({ $can: 'items:write', on: { $slot: 'item' } }, ctx)).toBe(false);
		expect(evaluate({ $can: 'items:write', on: { $slot: 'other' } }, ctx)).toBe(true);
		expect(evaluate([{ label: { $slot: 'other.id' } }, 'x'], ctx)).toEqual([{ label: 7 }, 'x']);
	});

	it('evaluates logic over values and permission checks', () => {
		expect(evaluate({ $eq: [{ $slot: 'other.id' }, 7] }, ctx)).toBe(true);
		expect(evaluate({ $eq: [{ $slot: 'item.owner' }, { name: 'Ada' }] }, ctx)).toBe(true);
		expect(evaluate({ $eq: [{ $slot: 'missing' }, null] }, ctx)).toBe(true);
		expect(evaluate({ $and: [{ $eq: [{ $slot: 'other.id' }, 7] }, { $can: 'items:write', on: { $slot: 'other' } }] }, ctx)).toBe(true);
		expect(evaluate({ $and: [true, { $can: 'items:write', on: { $slot: 'item' } }] }, ctx)).toBe(false);
		expect(evaluate({ $or: [false, { $not: { $eq: [1, 2] } }] }, ctx)).toBe(true);
		expect(evaluate({ $and: [true, 'yes'] }, ctx)).toBe(false);
	});

	it('does not read inherited properties', () => {
		expect(evaluate({ $slot: 'constructor' }, ctx)).toBeUndefined();
		expect(evaluate({ $data: '__proto__' }, ctx)).toBeUndefined();
	});
});

describe('hashSpec', () => {
	it('ignores line endings and trailing whitespace', async () => {
		expect(await hashSpec('a  \r\nb\n\n')).toBe(await hashSpec('a\nb'));
		expect(await hashSpec('a\nb')).not.toBe(await hashSpec('a\nc'));
	});
});
