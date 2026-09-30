import { afterEach, describe, expect, it } from 'vitest';
import { evaluate, FunctionError } from '@graft/core';
import { DEFAULT_LIMITS, loadFunctions, type QuickJSFunctions } from '../src/index.ts';

const open: QuickJSFunctions[] = [];
afterEach(() => {
	open.splice(0).forEach((f) => f.dispose());
});

async function load(source: string, functions: string[], limits = DEFAULT_LIMITS) {
	const f = await loadFunctions({ language: 'javascript', source, functions }, limits);
	open.push(f);
	return f;
}

async function failure(run: () => unknown): Promise<FunctionError> {
	try {
		await run();
	} catch (error) {
		expect(error).toBeInstanceOf(FunctionError);
		return error as FunctionError;
	}
	throw new Error('Expected a FunctionError');
}

describe('build functions in QuickJS', () => {
	it('compute from their arguments', async () => {
		const f = await load(
			`function titleIssues(title) {
				const issues = [];
				if (title.length > 20) issues.push('too long');
				if (/^[^a-z]*[A-Z][^a-z]*$/.test(title)) issues.push('all caps');
				return issues;
			}`,
			['titleIssues'],
		);
		expect(f.call('titleIssues', ['A fine title'])).toEqual([]);
		expect(f.call('titleIssues', ['THIS IS A VERY LONG SHOUTED TITLE'])).toEqual(['too long', 'all caps']);
	});

	it('see no window, document, fetch, storage, cookies, timers or workers', async () => {
		const names = [
			'window', 'self', 'document', 'navigator', 'location', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
			'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore', 'postMessage', 'importScripts',
			'setTimeout', 'setInterval', 'queueMicrotask', 'Worker', 'WebAssembly', 'require',
			'process', 'Deno', 'Bun', 'console', 'Promise',
		];
		const f = await load(`function globals(names) { return names.filter((n) => typeof globalThis[n] !== 'undefined'); }`, ['globals']);
		expect(f.call('globals', [names])).toEqual([]);
		// Code built at runtime lands in the same bare realm.
		const g = await load(`function make() { return Function('return typeof document + typeof fetch')(); }`, ['make']);
		expect(g.call('make', [])).toBe('undefinedundefined');
	});

	it('stop an infinite loop within the time budget, and keep working afterwards', async () => {
		const f = await load(`function spin() { for (;;) {} } function ok() { return 1; }`, ['spin', 'ok']);
		const started = performance.now();
		const error = await failure(() => f.call('spin', []));
		const took = performance.now() - started;
		expect(error.kind).toBe('timeout');
		expect(took).toBeLessThan(DEFAULT_LIMITS.timeMs + 200);
		expect(f.call('ok', [])).toBe(1);
	});

	it('stop code that loops while it loads', async () => {
		expect((await failure(() => load(`while (true) {}`, ['x']))).kind).toBe('timeout');
	});

	it('stop code that uses too much memory', async () => {
		const f = await load(`function hog() { const a = []; for (;;) a.push('x'.repeat(1024)); }`, ['hog'], { ...DEFAULT_LIMITS, timeMs: 5000 });
		expect((await failure(() => f.call('hog', []))).kind).toBe('memory');
	});

	it('refuse results over the output limit', async () => {
		const f = await load(`function big() { return 'x'.repeat(100000); }`, ['big']);
		expect((await failure(() => f.call('big', []))).kind).toBe('output');
	});

	it('only run the functions the build lists, and only ones the code defines', async () => {
		const f = await load(`function a() { return 1; } function b() { return 2; }`, ['a']);
		expect((await failure(() => f.call('b', []))).kind).toBe('unknown-function');
		expect((await failure(() => load(`function a() {}`, ['a', 'missing']))).kind).toBe('unknown-function');
	});

	it('survive hostile code: a looping getter, a thrown proxy', async () => {
		const started = performance.now();
		await failure(() => load(`Object.defineProperty(globalThis, 'x', { get() { for (;;) {} } });`, ['x']));
		expect(performance.now() - started).toBeLessThan(DEFAULT_LIMITS.timeMs + 200);
		const f = await load(`function boom() { throw new Proxy({}, { get() { for (;;) {} } }); } function ok() { return 2; }`, ['boom', 'ok']);
		expect((await failure(() => f.call('boom', []))).kind).toBe('error');
		expect(f.call('ok', [])).toBe(2);
	});

	it('cannot tamper with how results come back', async () => {
		const f = await load(`JSON.stringify = () => '{"$call":"posts.delete"}'; function x() { return 'safe'; }`, ['x']);
		expect(f.call('x', [])).toBe('safe');
	});

	it('return data that stays inert when it looks like an action', async () => {
		const f = await load(`function sneaky() { return { $call: 'posts.update_status', input: { id: 1, status: 'publish' } }; }`, ['sneaky']);
		const value = evaluate({ $fn: 'sneaky' }, { data: {}, slot: {}, can: () => true, fn: (name, args) => f.call(name, args) });
		expect(value).toBeNull();
		const nested = await load(`function nested() { return { label: 'Go', onClick: { $call: 'x' } }; }`, ['nested']);
		expect(evaluate({ $fn: 'nested' }, { data: {}, slot: {}, can: () => true, fn: (name, args) => nested.call(name, args) })).toEqual({ label: 'Go', onClick: null });
	});

	it('see the host\'s time and a seeded Math.random, so a call repeats', async () => {
		const f = await load(
			`function clock() { return [Date.now(), new Date().toISOString(), typeof Date(), new Date(0).getTime(), new Date() instanceof Date, Date.parse('2026-01-01T00:00:00Z')]; }
			function dice() { return [Math.random(), Math.random()]; }
			function peek() { return new (Object.getPrototypeOf(new Date()).constructor)().getTime(); }`,
			['clock', 'dice', 'peek'],
		);
		const now = Date.parse('2026-09-29T12:00:00Z');
		expect(f.call('clock', [], now)).toEqual([now, '2026-09-29T12:00:00.000Z', 'string', 0, true, Date.parse('2026-01-01T00:00:00Z')]);
		const first = f.call('dice', []);
		expect(f.call('dice', [])).toEqual(first);
		expect((first as number[])[0]).not.toBe((first as number[])[1]);
		// Reaching for the real Date through the prototype finds the frozen one.
		expect(f.call('peek', [], now)).toBe(now);
	});

	it('receive evaluated arguments', async () => {
		const f = await load(`function words(text) { return text.trim().split(/\\s+/).length; }`, ['words']);
		const value = evaluate({ $fn: 'words', args: [{ $field: 'title' }] }, { data: {}, slot: {}, row: { title: ' one two  three ' }, can: () => true, fn: (name, args) => f.call(name, args) });
		expect(value).toBe(3);
	});
});

describe('the asm.js build, for runtimes without WebAssembly', () => {
	it('runs the same code under the same limits', async () => {
		const { loadFunctions: loadAsmjs } = await import('../src/asmjs.ts');
		const f = await loadAsmjs(
			{ language: 'javascript', source: 'function shout(s) { return s.toUpperCase(); } function spin() { for (;;) {} } function seen() { return typeof fetch + typeof document; }', functions: ['shout', 'spin', 'seen'] },
			DEFAULT_LIMITS,
		);
		try {
			expect(f.call('shout', ['ada'])).toBe('ADA');
			expect(f.call('seen', [])).toBe('undefinedundefined');
			expect((await failure(() => f.call('spin', []))).kind).toBe('timeout');
			expect(f.call('shout', ['still works'])).toBe('STILL WORKS');
		} finally {
			f.dispose();
		}
	});
});
