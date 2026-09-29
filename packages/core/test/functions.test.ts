import { describe, expect, it } from 'vitest';
import {
	describeChange,
	extractRefs,
	FunctionError,
	hashSurface,
	staticCheck,
	validateBuild,
	validateSpec,
	verifyBuild,
	type Build,
	type ComponentSemantics,
	type FunctionRunner,
	type Sandbox,
	type Surface,
	type Value,
} from '../src/index.ts';

/** A host whose surface runs build functions, with a label and a button. */
const limits = { timeMs: 50, memoryBytes: 1 << 20, outputBytes: 1024, sourceBytes: 200 };
const surface: Surface = {
	graft: 1,
	host: 'acme',
	hostVersion: '1.0',
	slots: { page: { kind: 'owned', title: 'Page' } },
	components: {
		stack: { props: { type: 'object' }, children: 'any' },
		label: { props: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false } },
		button: { props: { type: 'object', properties: { onClick: {} }, additionalProperties: false } },
	},
	capabilities: {
		'items.list': { kind: 'read', input: { type: 'object' }, output: {}, scopes: ['items:read'] },
		'items.close': { kind: 'write', input: { type: 'object' }, output: {}, scopes: ['items:write'] },
	},
	scopes: { 'items:read': { title: 'See items' }, 'items:write': { title: 'Close items' } },
	functions: { runtime: 'quickjs', limits },
};
surface.hash = await hashSurface(surface);
const { functions: _, ...plain } = surface;
const noFunctions: Surface = { ...plain, hash: await hashSurface(plain as Surface) };

const spec = validateSpec(`---
graft: 1
id: shout
host: acme
mount: { slot: page }
permissions: [items:read, items:write]
---

# Shout

## Acceptance criteria

- Shouts the name {#shout}
`).spec!;

const code = { language: 'javascript' as const, source: 'function shout(s) { return s.toUpperCase(); }', functions: ['shout'] };

function build(tree: Build['tree'], options: { code?: Build['code'] | null; data?: Build['data']; target?: Surface } = {}): Build {
	const target = options.target ?? surface;
	const b: Build = {
		graft: 1,
		spec: { id: 'shout', hash: 'sha256:0' },
		surface: { host: 'acme', hostVersion: '1.0', hash: target.hash! },
		mount: { slot: 'page' },
		data: options.data ?? {},
		tree,
		checks: [{ criterion: 'shout', fixtures: { name: 'ada' }, view_as: 'v', expect: [{ text: 'ADA' }] }],
		refs: { slot: 'page', components: {}, capabilities: [], scopes: [] },
		...(options.code === null ? {} : { code: options.code ?? code }),
		provenance: { compiler: 'handwritten', strategy: 'handwritten' },
	};
	b.refs = extractRefs(b, target);
	return b;
}

const label = (text: Value): Build['tree'] => ({ type: 'label', props: { text } });
const shout: Value = { $fn: 'shout', args: ['ada'] };
const errors = async (b: Build, target = surface) => (await validateBuild(b, target)).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

describe('validating builds with code', () => {
	it('accepts $fn in props, where the prop schema expects a literal', async () => {
		expect(await errors(build(label(shout)))).toEqual([]);
	});

	it('refuses code and $fn where the host runs no functions', async () => {
		expect(await errors(build(label(shout), { target: noFunctions }), noFunctions)).toEqual(['build-functions-unsupported', 'build-functions-unsupported']);
	});

	it('refuses functions the code does not list or declare', async () => {
		expect(await errors(build(label({ $fn: 'whisper' })))).toEqual(['build-unknown-function']);
		expect(await errors(build(label(shout), { code: { ...code, functions: ['shout', 'whisper'] } }))).toEqual(['build-unknown-function']);
	});

	it('refuses code over the size limit', async () => {
		expect(await errors(build(label(shout), { code: { ...code, source: `${code.source}\n${'//'.repeat(200)}` } }))).toEqual(['build-code-too-large']);
	});

	it('never lets code decide what is read or written', async () => {
		const click = { type: 'button', props: { onClick: { $call: 'items.close', input: { id: shout } } } };
		expect(await errors(build({ type: 'stack', children: [click] }))).toEqual(['build-fn-not-allowed']);
		const data = { items: { call: 'items.list', input: { q: shout } } };
		expect(await errors(build(label('x'), { data }))).toEqual(['build-fn-not-allowed']);
	});
});

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
	label: ({ props, emit }) => emit.text(String(props.text)),
	button: () => {},
};
const runner = (call: FunctionRunner['call']) => async () => ({ call });
const verify = (b: Build, loadFunctions?: Parameters<typeof verifyBuild>[0]['loadFunctions']) =>
	verifyBuild({ build: b, spec, surface, sandbox, semantics, createCan: () => () => true, ...(loadFunctions ? { loadFunctions } : {}) });

describe('verifying builds with code', () => {
	it('runs functions through the host sandbox', async () => {
		const result = await verify(build(label(shout)), runner((_name, args) => String(args[0]).toUpperCase()));
		expect(result.results.flatMap((r) => r.failures)).toEqual([]);
	});

	it('fails every check without a sandbox to run the code', async () => {
		const result = await verify(build(label(shout)));
		expect(result.results.flatMap((r) => r.failures)).toEqual(['The build has code, and this verifier has no sandbox to run it.']);
	});

	it('fails a check whose function broke a limit, and shows the value as null', async () => {
		const result = await verify(
			build(label(shout)),
			runner(() => {
				throw new FunctionError('timeout', '"shout" ran longer than 50 ms and was stopped');
			}),
		);
		expect(result.results[0]!.failures).toEqual(['Function "shout" failed: "shout" ran longer than 50 ms and was stopped.', 'Expected the text "ADA" to be shown.']);
	});
});

describe('upgrading builds with code', () => {
	it('regenerates when the host stops running functions, and re-verifies when limits change', () => {
		const b = build(label(shout));
		const removed = staticCheck(b, surface, noFunctions);
		expect(removed.start).toBe('regenerate');
		expect(removed.changes.map(describeChange)).toEqual(['the host no longer runs build functions']);
		const tighter = staticCheck(b, surface, { ...surface, functions: { runtime: 'quickjs', limits: { ...limits, timeMs: 10 } } });
		expect(tighter.start).toBe('reverify');
		expect(staticCheck(build(label('x'), { code: null }), surface, noFunctions).changes).toEqual([]);
	});
});
