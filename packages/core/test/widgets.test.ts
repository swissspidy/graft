import { describe, expect, it } from 'vitest';
import {
	describeChange,
	extractRefs,
	hashSurface,
	sanitizeWidgetTree,
	staticCheck,
	validateBuild,
	validateSpec,
	verifyBuild,
	type Build,
	type ComponentSemantics,
	type Sandbox,
	type Surface,
} from '../src/index.ts';

const limits = { components: ['stack', 'text', 'button'], maxNodes: 10 };

describe('sanitizing what a widget draws', () => {
	it('keeps allow-listed nodes, inert props and event markers', () => {
		const { tree, problems } = sanitizeWidgetTree(
			{
				type: 'stack',
				key: 1,
				props: { gap: 2, extra: { $call: 'posts.delete' }, list: [{ ok: true, $fn: 'x' }] },
				children: [
					{ type: 'text', children: 'Hi' },
					{ type: 'button', props: { id: 'go', label: 'Go', onClick: { $event: 'go', payload: { id: 1, $call: 'x' } } } },
					{ type: 'script', children: 'alert(1)' },
				],
			},
			limits,
		);
		expect(tree).toEqual({
			type: 'stack',
			key: '1',
			props: { gap: 2, extra: null, list: [null] },
			children: [
				{ type: 'text', children: 'Hi' },
				{ type: 'button', props: { id: 'go', label: 'Go', onClick: { $event: 'go', payload: null } } },
			],
		});
		expect(problems).toEqual(['/children/2 uses "script", which widgets cannot draw (only stack, text, button).']);
	});

	it('stops at the node limit and refuses a root that is not a node', () => {
		const many = { type: 'stack', children: Array.from({ length: 20 }, () => ({ type: 'text', children: 'x' })) };
		const { tree, problems } = sanitizeWidgetTree(many, limits);
		expect((tree?.children as unknown[]).length).toBe(9);
		expect(problems).toContain('The widget drew more than 10 nodes.');
		expect(sanitizeWidgetTree('<b>hi</b>', limits)).toEqual({ problems: ['The root is not a node.'] });
		expect(sanitizeWidgetTree({ type: 'button', props: { onClick: { $event: 'bad name!' } } }, limits).problems).toEqual(['Event "bad name!" is not a valid name.']);
	});
});

/** A host with a widget component, whose widgets may draw stacks, texts and buttons. */
const surface: Surface = {
	graft: 1,
	host: 'acme',
	hostVersion: '1.0',
	slots: { page: { kind: 'owned', title: 'Page' } },
	components: {
		stack: { props: { type: 'object', additionalProperties: false }, children: 'any' },
		text: { props: { type: 'object', additionalProperties: false }, children: 'text' },
		button: {
			props: {
				type: 'object',
				properties: { id: { type: 'string' }, label: { type: 'string' }, onClick: { type: 'object', required: ['$call'] } },
				required: ['id', 'label', 'onClick'],
				additionalProperties: false,
			},
		},
		widget: {
			props: { type: 'object', properties: { render: { type: 'string' }, update: { type: 'string' }, input: {}, state: {} }, required: ['render'], additionalProperties: false },
		},
	},
	capabilities: { 'items.close': { kind: 'write', input: { type: 'object' }, output: {}, scopes: ['items:write'] } },
	scopes: { 'items:write': { title: 'Close items' } },
	functions: { runtime: 'quickjs', limits: { timeMs: 50, memoryBytes: 1 << 20, outputBytes: 4096, sourceBytes: 4096 }, widgets: limits },
};
surface.hash = await hashSurface(surface);

const spec = validateSpec(`---
graft: 1
id: counter
host: acme
mount: { slot: page }
permissions: [items:write]
---

# Counter

## Acceptance criteria

- Counts clicks {#count}
`).spec!;

const code = { language: 'javascript' as const, source: 'function draw() {} function step() {}', functions: ['draw', 'step'] };

function build(checks: Build['checks'], props: Record<string, unknown> = { render: 'draw', update: 'step', state: 0 }): Build {
	const b: Build = {
		graft: 1,
		spec: { id: 'counter', hash: 'sha256:0' },
		surface: { host: 'acme', hostVersion: '1.0', hash: surface.hash! },
		mount: { slot: 'page' },
		data: {},
		tree: { type: 'widget', props: props as never },
		checks,
		refs: { slot: 'page', components: {}, capabilities: [], scopes: [] },
		code,
		provenance: { compiler: 'handwritten', strategy: 'handwritten' },
	};
	b.refs = extractRefs(b, surface);
	return b;
}

const sandbox: Sandbox = {
	async reset() {},
	async seed() {
		return { users: { v: ['viewer'] } };
	},
	async scopes(_user, scopes) {
		return Object.fromEntries(scopes.map((s) => [s, true]));
	},
	async call() {
		return null;
	},
	async slotInstances() {
		return [{}];
	},
	async assert() {
		return { ok: true, actual: null };
	},
};
const semantics: ComponentSemantics = {
	stack: () => {},
	button: ({ props, emit }) => emit.action({ id: String(props.id), label: String(props.label), available: true, action: props.onClick as never }),
};

/** The counter: a text with the count, a button that adds one, and (sometimes) something else. */
function counter(extra?: unknown) {
	return async () => ({
		call(name: string, args: unknown[]) {
			if (name === 'step') {
				return (args[0] as number) + 1;
			}
			const children: unknown[] = [
				{ type: 'text', children: `Count: ${String(args[1])}` },
				{ type: 'button', props: { id: 'add', label: 'Add', onClick: { $event: 'add' } } },
			];
			if (extra) {
				children.push(extra);
			}
			return { type: 'stack', children };
		},
	});
}

const verify = (b: Build, extra?: unknown) => verifyBuild({ build: b, spec, surface, sandbox, semantics, createCan: () => () => true, loadFunctions: counter(extra) });

describe('widgets in builds', () => {
	it('validate their functions and need a surface that runs widgets', async () => {
		const ok = await validateBuild(build([{ criterion: 'count', expect: [{ text: 'x' }] }]), surface);
		expect(ok.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
		const unknown = await validateBuild(build([{ criterion: 'count', expect: [{ text: 'x' }] }], { render: 'nope' }), surface);
		expect(unknown.diagnostics.map((d) => d.code)).toContain('build-unknown-function');
		const { widgets: _, ...noWidgets } = surface.functions!;
		const without = { ...surface, functions: noWidgets } as Surface;
		without.hash = await hashSurface(without);
		const b = build([{ criterion: 'count', expect: [{ text: 'x' }] }]);
		b.surface.hash = without.hash;
		expect((await validateBuild(b, without)).diagnostics.map((d) => d.code)).toContain('build-widgets-unsupported');
	});

	it('are verified through their events', async () => {
		const result = await verify(build([{ criterion: 'count', view_as: 'v', steps: [{ action: 'add' }, { action: 'add' }], expect: [{ text: 'Count: 2' }] }]));
		expect(result.results.flatMap((r) => r.failures)).toEqual([]);
	});

	it('cannot reach capabilities, and fail verification when they draw invalid trees', async () => {
		const sneaky = { type: 'button', props: { id: 'close', label: 'Close', onClick: { $call: 'items.close', input: {} } } };
		const result = await verify(build([{ criterion: 'count', view_as: 'v', expect: [{ action: 'close', available: false }] }]), sneaky);
		// The $call became null: the button is dead, and the verifier says why.
		expect(result.results[0]!.failures).toEqual([expect.stringMatching(/^The widget at \/tree: \/children\/2\/props\/onClick: Props of "button": /)]);

		const unknownProp = { type: 'text', props: { color: 'red' }, children: 'x' };
		const bad = await verify(build([{ criterion: 'count', view_as: 'v', expect: [{ text: 'Count: 0' }] }]), unknownProp);
		expect(bad.passed).toBe(false);
		expect(bad.results[0]!.failures[0]).toMatch(/^The widget at \/tree: \/children\/2\/props/);
	});

	it('keep a state of null that update returned, instead of starting over', async () => {
		const clearing = async () => ({
			call(name: string, args: unknown[]) {
				if (name === 'step') {
					return null;
				}
				return { type: 'stack', children: [{ type: 'text', children: `State: ${JSON.stringify(args[1])}` }, { type: 'button', props: { id: 'add', label: 'Clear', onClick: { $event: 'clear' } } }] };
			},
		});
		const b = build([{ criterion: 'count', view_as: 'v', steps: [{ action: 'add' }], expect: [{ text: 'State: null' }] }], { render: 'draw', update: 'step', state: 5 });
		const result = await verifyBuild({ build: b, spec, surface, sandbox, semantics, createCan: () => () => true, loadFunctions: clearing });
		expect(result.results.flatMap((r) => r.failures)).toEqual([]);
	});

	it('need regenerating when the host stops running widgets', () => {
		const { widgets: _, ...noWidgets } = surface.functions!;
		const check = staticCheck(build([]), surface, { ...surface, functions: noWidgets });
		expect(check.start).toBe('regenerate');
		expect(check.changes.map(describeChange)).toEqual(['the host no longer runs interactive widgets']);
	});
});
