import { beforeAll, describe, expect, it } from 'vitest';
import {
	describeChange,
	evaluate,
	extractRefs,
	hashSurface,
	resolveWidgetUse,
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
			props: { type: 'object', properties: { render: { type: 'string' }, update: { type: 'string' }, input: {}, state: {}, actions: { type: 'object' } }, required: ['render'], additionalProperties: false },
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

	it('run declared actions on rows of their input, and only those', async () => {
		const calls: Array<[string, unknown]> = [];
		const withRows: Sandbox = {
			...sandbox,
			async call(_user, capability, input) {
				calls.push([capability, input]);
				return capability === 'items.list' ? { items: [{ id: 1, title: 'One' }, { id: 2, title: 'Two' }] } : {};
			},
		};
		const drawing = async () => ({
			call() {
				return {
					type: 'stack',
					children: [
						{ type: 'button', props: { id: 'close-two', label: 'Close', onClick: { $use: 'close', row: 2 } } },
						{ type: 'button', props: { id: 'close-made-up', label: 'Close', onClick: { $use: 'close', row: 99 } } },
					],
				};
			},
		});
		const surfaceWithList: Surface = {
			...surface,
			capabilities: { ...surface.capabilities, 'items.list': { kind: 'read', input: { type: 'object' }, output: {}, scopes: ['items:write'] } },
		};
		surfaceWithList.hash = await hashSurface(surfaceWithList);
		const b = build(
			[{ criterion: 'count', view_as: 'v', steps: [{ action: 'close-two' }], expect: [{ action: 'close-made-up', available: false }] }],
			{ render: 'draw', input: { $data: 'items.items' }, actions: { close: { call: { $call: 'items.close', input: { id: { $field: 'id' } } } } } },
		);
		b.data = { items: { call: 'items.list', input: {} } };
		b.surface.hash = surfaceWithList.hash;
		b.refs = extractRefs(b, surfaceWithList);
		const result = await verifyBuild({ build: b, spec, surface: surfaceWithList, sandbox: withRows, semantics, createCan: () => () => true, loadFunctions: drawing });
		expect(calls.filter(([c]) => c === 'items.close')).toEqual([['items.close', { id: 2 }]]);
		expect(result.results[0]!.failures).toEqual(['The widget at /tree: The widget offers "close" on a row that is not in its input.']);
	});

	it('offer a declared action only where its visible condition holds', () => {
		const actions = { close: { call: { $call: 'items.close', input: { id: { $field: 'id' } } }, visible: { $can: 'items:write' } } };
		const input = [{ id: 1 }, { id: 2 }];
		const ctx = (allowed: number) => ({ data: {}, slot: {}, can: (_scope: string, on: unknown) => (on as { id: number }).id === allowed });
		expect(resolveWidgetUse({ $use: 'close', row: 1 }, actions, input, ctx(1))).toMatchObject({ available: true, row: { id: 1 }, action: { capability: 'items.close', input: { id: 1 } } });
		expect(resolveWidgetUse({ $use: 'close', row: 2 }, actions, input, ctx(1)).available).toBe(false);
		expect(resolveWidgetUse({ $use: 'close', row: { id: 2, title: 'forged' } }, actions, input, ctx(2)).row).toEqual({ id: 2 });
	});

	it('need regenerating when the host stops running widgets', () => {
		const { widgets: _, ...noWidgets } = surface.functions!;
		const check = staticCheck(build([]), surface, { ...surface, functions: noWidgets });
		expect(check.start).toBe('regenerate');
		expect(check.changes.map(describeChange)).toEqual(['the host no longer runs interactive widgets']);
	});
});

describe('widget inputs', () => {
	const inputLimits = { components: ['stack', 'text', 'button', 'field'], inputs: ['field'], maxNodes: 10 };
	const withInputs: Surface = {
		...surface,
		components: {
			...surface.components,
			field: { props: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, value: {}, onChange: {} }, required: ['id', 'label'], additionalProperties: false } },
		},
		capabilities: { ...surface.capabilities, 'items.rename': { kind: 'write', input: { type: 'object' }, output: {}, scopes: ['items:write'] } },
		functions: { ...surface.functions!, widgets: inputLimits },
	};
	beforeAll(async () => {
		withInputs.hash = await hashSurface(withInputs);
	});

	const rename = { call: { $call: 'items.rename', input: { id: { $field: 'id' }, title: { $input: 'title' } } } };
	const props = { render: 'draw', update: 'step', input: [{ id: 1, title: 'One' }], state: '', actions: { rename } };
	function inputBuild(checks: Build['checks'], widgetProps: Record<string, unknown> = props): Build {
		const b = build(checks, widgetProps);
		b.surface.hash = withInputs.hash!;
		b.refs = extractRefs(b, withInputs);
		return b;
	}
	/** Draws a field that starts with the row's title (or `redraw` after an event), and a Rename button. */
	const drawing = (redraw?: string) => async () => ({
		call(name: string, args: unknown[]) {
			if (name === 'step') {
				return args[2];
			}
			const [rows, state] = args as [Array<{ title: string }>, string];
			return {
				type: 'stack',
				children: [
					{ type: 'text', children: `Typed: ${state}` },
					{ type: 'field', props: { id: 'title', label: 'Title', value: state && redraw ? redraw : rows[0]!.title, onChange: { $event: 'typed' } } },
					{ type: 'button', props: { id: 'rename', label: 'Rename', onClick: { $use: 'rename', row: 1 } } },
				],
			};
		},
	});
	const recording = (calls: Array<[string, unknown]>): Sandbox => ({
		...sandbox,
		async call(_user, capability, input) {
			calls.push([capability, input]);
			return {};
		},
	});

	it('read what the viewer sees with $input, and only there', () => {
		const ctx = { data: {}, slot: {}, can: () => true, inputs: { title: 'Uno' } };
		expect(evaluate({ $input: 'title' }, ctx)).toBe('Uno');
		expect(evaluate({ $input: 'other' }, ctx)).toBeNull();
		expect(evaluate({ $input: 'title' }, { data: {}, slot: {}, can: () => true })).toBeNull();
	});

	it('may only be read in a widget’s declared actions', async () => {
		const ok = await validateBuild(inputBuild([{ criterion: 'count', expect: [{ text: 'x' }] }]), withInputs);
		expect(ok.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
		const inState = await validateBuild(inputBuild([{ criterion: 'count', expect: [{ text: 'x' }] }], { ...props, state: { $input: 'title' } }), withInputs);
		expect(inState.diagnostics.map((d) => d.code)).toContain('build-input-not-allowed');
		const inVisible = await validateBuild(inputBuild([{ criterion: 'count', expect: [{ text: 'x' }] }], { ...props, actions: { rename: { ...rename, visible: { $eq: [{ $input: 'title' }, 'x'] } } } }), withInputs);
		expect(inVisible.diagnostics.map((d) => d.code)).toContain('build-input-not-allowed');
	});

	it('send what the viewer typed, and tell update as they type', async () => {
		const calls: Array<[string, unknown]> = [];
		const b = inputBuild([
			{ criterion: 'count', view_as: 'v', steps: [{ fill: 'title', value: 'Uno' }, { action: 'rename' }], expect: [{ text: 'Typed: Uno' }, { input: 'title', value: 'Uno' }] },
		]);
		const result = await verifyBuild({ build: b, spec, surface: withInputs, sandbox: recording(calls), semantics, createCan: () => () => true, loadFunctions: drawing() });
		expect(result.results.flatMap((r) => r.failures)).toEqual([]);
		expect(calls).toEqual([['items.rename', { id: 1, title: 'Uno' }]]);
	});

	it('send what the code drew until the viewer types, and never what the code redraws over their typing', async () => {
		const calls: Array<[string, unknown]> = [];
		const b = inputBuild([
			{ criterion: 'count', view_as: 'v', steps: [{ action: 'rename' }], expect: [{ input: 'title', value: 'One' }] },
			{ criterion: 'count', view_as: 'v', steps: [{ fill: 'title', value: 'Uno' }, { action: 'rename' }], expect: [{ input: 'title', value: 'Uno' }] },
		]);
		const result = await verifyBuild({ build: b, spec, surface: withInputs, sandbox: recording(calls), semantics, createCan: () => () => true, loadFunctions: drawing('Hidden') });
		expect(result.results.flatMap((r) => r.failures)).toEqual([]);
		expect(calls).toEqual([
			['items.rename', { id: 1, title: 'One' }],
			['items.rename', { id: 1, title: 'Uno' }],
		]);
	});

	it('fail a check that types into an input that is not there', async () => {
		const b = inputBuild([{ criterion: 'count', view_as: 'v', steps: [{ fill: 'nope', value: 'x' }], expect: [{ text: 'x' }] }]);
		const result = await verifyBuild({ build: b, spec, surface: withInputs, sandbox, semantics, createCan: () => () => true, loadFunctions: drawing() });
		expect(result.results[0]!.failures).toEqual(['Step 1: no "nope" input.']);
	});
});
