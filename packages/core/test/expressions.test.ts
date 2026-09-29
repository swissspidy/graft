import { describe, expect, it } from 'vitest';
import { describeCheck, evaluate, extractRefs, hashSurface, validateBuild, validateSpec, verifyBuild, type Build, type ComponentSemantics, type Sandbox, type Surface, type Value } from '../src/index.ts';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-29T12:00:00Z');
const ctx = (row?: unknown) => ({ data: {}, slot: {}, row, can: () => true, now });

describe('computed expressions', () => {
	it('compare numbers and strings, and nothing else', () => {
		expect(evaluate({ $gt: [3, 2] }, ctx())).toBe(true);
		expect(evaluate({ $gte: [2, 2] }, ctx())).toBe(true);
		expect(evaluate({ $lt: ['a', 'b'] }, ctx())).toBe(true);
		expect(evaluate({ $lte: [3, 2] }, ctx())).toBe(false);
		expect(evaluate({ $gt: [3, '2'] }, ctx())).toBe(false);
		expect(evaluate({ $gt: [null, 1] }, ctx())).toBe(false);
	});

	it('choose with $if, evaluating only the chosen branch', () => {
		const tone: Value = { $if: [{ $lt: [{ $field: 'age' }, 7] }, 'success', { $if: [{ $lt: [{ $field: 'age' }, 30] }, 'warning', 'error'] }] };
		expect([3, 10, 40].map((age) => evaluate(tone, ctx({ age })))).toEqual(['success', 'warning', 'error']);
		expect(evaluate({ $if: [true, { $field: 'a' }, { $call: 'x.y' }] }, ctx({ a: 1 }))).toBe(1);
	});

	it('count whole days since a date, against the context clock', () => {
		expect(evaluate({ $daysSince: '2026-09-19T12:00:00Z' }, ctx())).toBe(10);
		expect(evaluate({ $daysSince: '2026-09-29T00:00:00Z' }, ctx())).toBe(0);
		expect(evaluate({ $daysSince: { $field: 'modified' } }, ctx({ modified: '2026-08-30T12:00:00Z' }))).toBe(30);
		expect(evaluate({ $daysSince: 'not a date' }, ctx())).toBeNull();
		expect(evaluate({ $daysSince: 42 }, ctx())).toBeNull();
	});
});

// A tiny host with one component whose props are strictly typed, to see
// validation treat computed values like bindings.
const surface: Surface = {
	graft: 1,
	host: 'acme',
	hostVersion: '1.0',
	slots: { page: { kind: 'owned', title: 'Page' } },
	components: {
		grid: {
			props: {
				type: 'object',
				properties: {
					rows: { type: 'array' },
					age: { description: 'Per row.', type: 'object' },
					tone: { enum: ['success', 'warning', 'error'] },
				},
				additionalProperties: false,
			},
		},
	},
	capabilities: { 'items.list': { kind: 'read', input: {}, output: {}, scopes: ['items:read'] } },
	scopes: { 'items:read': { title: 'See items' } },
};

const spec = validateSpec(`---
graft: 1
id: aging
host: acme
mount: { slot: page }
permissions: [items:read]
---

# Aging items

## Acceptance criteria

- Shows how old each item is {#age}
- Old items are marked {#tone}
`).spec!;

function build(tone: Value, checks: Build['checks']): Build {
	const b: Build = {
		graft: 1,
		spec: { id: 'aging', hash: 'sha256:0' },
		surface: { host: 'acme', hostVersion: '1.0', hash: 'sha256:0' },
		mount: { slot: 'page' },
		data: { items: { call: 'items.list', input: {} } },
		tree: { type: 'grid', props: { rows: { $data: 'items' }, age: { $daysSince: { $field: 'modified' } }, tone } },
		checks,
		refs: { slot: 'page', components: {}, capabilities: [], scopes: [] },
		provenance: { compiler: 'handwritten', strategy: 'handwritten' },
	};
	b.refs = extractRefs(b, surface);
	return b;
}

/** Items are "modified" when seeded; the grid shows their age and tone. */
function sandbox(): Sandbox {
	let items: Array<{ title: string; modified: string }> = [];
	return {
		async reset() {
			items = [];
		},
		async seed(fixtures) {
			items = ((fixtures.items as string[] | undefined) ?? []).map((title) => ({ title, modified: new Date().toISOString() }));
			return { users: { v: ['viewer'] } };
		},
		async scopes(_user, scopes) {
			return Object.fromEntries(scopes.map((s) => [s, true]));
		},
		async call() {
			return items;
		},
		async slotInstances() {
			return [{}];
		},
		async assert() {
			return { ok: true, actual: null };
		},
	};
}

const semantics: ComponentSemantics = {
	grid: ({ props, raw, evaluate: evalRow, emit }) => {
		const rows = (props.rows as Array<{ title: string }>) ?? [];
		emit.table({
			columns: ['Title', 'Age'],
			rows: rows.map((row) => ({
				label: row.title,
				record: row,
				actions: [],
				cells: { Age: { text: `${String(evalRow(raw.age, row))} days`, tone: evalRow(raw.tone, row) as string } },
			})),
		});
	},
};

const tone: Value = { $if: [{ $gte: [{ $daysSince: { $field: 'modified' } }, 30] }, 'error', 'success'] };

describe('computed values in builds', () => {
	it('validate like bindings where a prop schema expects a literal', async () => {
		const b = build(tone, [{ criterion: 'age', expect: [{ rows: [] }] }, { criterion: 'tone', expect: [{ rows: [] }] }]);
		b.surface.hash = await hashSurface(surface);
		const result = await validateBuild(b, surface);
		expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
	});

	it('are checked at a later clock, cell by cell', async () => {
		const checks: Build['checks'] = [
			{ criterion: 'age', fixtures: { items: ['A'] }, view_as: 'v', clock: { advanceDays: 12 }, expect: [{ cell: { row: { title: 'A' }, column: 'Age', text: '12 days' } }] },
			{ criterion: 'tone', fixtures: { items: ['A'] }, view_as: 'v', clock: { advanceDays: 45 }, expect: [{ cell: { row: { title: 'A' }, column: 'Age', tone: 'error' } }] },
		];
		const pass = await verifyBuild({ build: build(tone, checks), spec, surface, sandbox: sandbox(), semantics, createCan: () => () => true });
		expect(pass.results.flatMap((r) => r.failures)).toEqual([]);

		const wrong = await verifyBuild({ build: build('success', checks), spec, surface, sandbox: sandbox(), semantics, createCan: () => () => true });
		expect(wrong.results.flatMap((r) => r.failures)).toEqual(['Expected the "Age" cell for title "A" to be marked "error", found "success".']);
	});

	it('are described with their clock', () => {
		const text = describeCheck({ criterion: 'tone', view_as: 'v', clock: { advanceDays: 45 }, expect: [{ cell: { row: { title: 'A' }, column: 'Age', tone: 'error' } }] });
		expect(text).toBe('When "v" opens it 45 days later, then the "Age" cell on "A" is marked "error".');
		expect(DAY).toBeGreaterThan(0);
	});
});
