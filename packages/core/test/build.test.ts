import { describe, expect, it } from 'vitest';
import {
	evaluate,
	extractRefs,
	hashSpec,
	hashSurface,
	isAction,
	validateBuild,
	validateSpec,
	type Build,
	type EvalContext,
	type Surface,
} from '../src/index.ts';

const surface: Surface = {
	graft: 1,
	host: 'acme',
	hostVersion: '1.0',
	slots: {
		page: { kind: 'owned', title: 'Page' },
		'row.actions': {
			kind: 'extension',
			title: 'Row actions',
			accepts: ['link'],
			provides: { type: 'object', properties: { item: { type: 'object' } } },
		},
	},
	components: {
		stack: { props: { type: 'object', additionalProperties: false }, children: 'any' },
		text: { props: { type: 'object', additionalProperties: false }, children: 'text' },
		list: {
			props: {
				type: 'object',
				properties: {
					rows: { type: 'array' },
					empty: { type: 'string' },
					actions: {
						type: 'array',
						items: {
							type: 'object',
							properties: { label: { type: 'string' }, onClick: { type: 'object', required: ['$call'] }, visible: {} },
							required: ['label', 'onClick'],
						},
					},
				},
				required: ['rows'],
				additionalProperties: false,
			},
		},
		link: {
			props: { type: 'object', properties: { label: { type: 'string' }, onClick: { type: 'object' } }, required: ['label'] },
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
		tree: {
			type: 'stack',
			children: [
				{ type: 'text', children: 'Open items' },
				{
					type: 'list',
					props: {
						rows: { $data: 'items.items' },
						empty: 'Nothing open',
						actions: [
							{
								label: 'Close',
								visible: { $can: 'items:write' },
								onClick: { $call: 'items.close', input: { id: { $field: 'id' } }, then: ['remove-row:items'], notice: 'Closed.' },
							},
						],
					},
				},
			],
		},
		checks: [
			{ criterion: 'open-only', expect: [{ rows: 1 }] },
			{ criterion: 'close', expect: [{ action: 'close' }] },
		],
		refs: { slot: 'page', components: {}, capabilities: [], scopes: [] },
		provenance: { compiler: 'handwritten', strategy: 'handwritten' },
	};
	b.refs = extractRefs(b, surface);
	return b;
}

const spec = validateSpec(specSource).spec!;

describe('extractRefs', () => {
	it('collects components with props, capabilities and scopes', async () => {
		expect((await build()).refs).toEqual({
			slot: 'page',
			components: { list: ['actions', 'empty', 'rows'], stack: [], text: [] },
			capabilities: ['items.close', 'items.list'],
			scopes: ['items:read', 'items:write'],
		});
	});
});

describe('validateBuild', () => {
	it('accepts a consistent build', async () => {
		const result = await validateBuild(await build(), surface, { spec: { spec, hash: await hashSpec(specSource) } });
		expect(result.diagnostics).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it('rejects stored refs that do not match the content', async () => {
		const b = await build();
		b.refs.scopes = ['items:read'];
		expect((await validateBuild(b, surface)).diagnostics.map((d) => d.code)).toEqual(['build-refs-mismatch']);
	});

	it('reports unknown symbols, bad props and inputs, but not bindings', async () => {
		const b = await build();
		const list = (b.tree.children as Build['tree'][])[1]!;
		list.props!.color = 'red';
		list.props!.empty = { $slot: 'nothing' };
		(list.props!.actions as unknown as Array<Record<string, unknown>>)[0]!.onClick = {
			$call: 'items.close',
			input: { id: 'seven' },
			then: ['refresh:elsewhere'],
		};
		(b.tree.children as Build['tree'][]).push({ type: 'chart' }, { type: 'text', children: [{ type: 'text' }] });
		b.data.items!.input = { status: 'closed' };
		b.data.more = { call: 'items.close', input: { id: { $data: 'items.first' } } };
		b.refs = extractRefs(b, surface);
		const codes = (await validateBuild(b, surface)).diagnostics.map((d) => `${d.code} ${d.path}`);
		expect(codes).toEqual([
			'build-invalid-value /tree/children/1/props/color',
			'build-unknown-slot-prop /tree/children/1/props/empty',
			'build-invalid-value /tree/children/1/props/actions/0/onClick/input/id',
			'build-unknown-data /tree/children/1/props/actions/0/onClick/then/0',
			'build-unknown-component /tree/children/2/type',
			'build-children /tree/children/3/children',
			'build-invalid-value /data/items/input/status',
			'build-data-not-read /data/more/call',
		]);
	});

	it('checks the slot and target surface', async () => {
		const b = await build();
		b.mount.slot = 'row.actions';
		b.surface.hash = 'sha256:other';
		b.refs = extractRefs(b, surface);
		expect((await validateBuild(b, surface)).diagnostics.map((d) => d.code)).toEqual([
			'build-surface-mismatch',
			'build-root-not-accepted',
		]);
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
		slot: { item: { id: 3 } },
		row: { id: 7, owner: { name: 'Ada' } },
		can: (scope, on) => scope === 'items:write' && (on as { id: number } | undefined)?.id === 7,
	};

	it('resolves bindings, permission checks and actions', () => {
		expect(evaluate({ $data: 'items.items.0.title' }, ctx)).toBe('A');
		expect(evaluate({ $field: 'owner.name' }, ctx)).toBe('Ada');
		expect(evaluate({ $slot: 'item.id' }, ctx)).toBe(3);
		expect(evaluate({ $data: 'missing.path' }, ctx)).toBeUndefined();
		expect(evaluate({ $can: 'items:write' }, ctx)).toBe(true);
		expect(evaluate({ $can: 'items:write', on: { $slot: 'item' } }, ctx)).toBe(false);
		const action = evaluate({ $call: 'items.close', input: { id: { $field: 'id' } }, then: ['remove-row:items'], notice: 'Closed.' }, ctx);
		expect(isAction(action)).toBe(true);
		expect(action).toEqual({ $action: true, capability: 'items.close', input: { id: 7 }, then: ['remove-row:items'], notice: 'Closed.', row: ctx.row });
		expect(evaluate([{ label: { $field: 'id' } }, 'x'], ctx)).toEqual([{ label: 7 }, 'x']);
	});

	it('evaluates logic over values and permission checks', () => {
		expect(evaluate({ $eq: [{ $field: 'id' }, 7] }, ctx)).toBe(true);
		expect(evaluate({ $eq: [{ $field: 'owner' }, { name: 'Ada' }] }, ctx)).toBe(true);
		expect(evaluate({ $eq: [{ $field: 'missing' }, null] }, ctx)).toBe(true);
		expect(evaluate({ $and: [{ $eq: [{ $field: 'id' }, 7] }, { $can: 'items:write' }] }, ctx)).toBe(true);
		expect(evaluate({ $and: [true, { $can: 'items:write', on: { $slot: 'item' } }] }, ctx)).toBe(false);
		expect(evaluate({ $or: [false, { $not: { $eq: [1, 2] } }] }, ctx)).toBe(true);
		expect(evaluate({ $and: [true, 'yes'] }, ctx)).toBe(false);
	});

	it('does not read inherited properties', () => {
		expect(evaluate({ $field: 'constructor' }, ctx)).toBeUndefined();
		expect(evaluate({ $data: '__proto__' }, ctx)).toBeUndefined();
	});
});

describe('hashSpec', () => {
	it('ignores line endings and trailing whitespace', async () => {
		expect(await hashSpec('a  \r\nb\n\n')).toBe(await hashSpec('a\nb'));
		expect(await hashSpec('a\nb')).not.toBe(await hashSpec('a\nc'));
	});
});
