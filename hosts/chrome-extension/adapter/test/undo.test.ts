import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Capability, Surface } from '@swissspidy/graft-core';
import { tasklet } from '../src/apps/tasklet.ts';
import { activityFrom, appendActivity, changedNothing, describeActivity, undoRefusal, worthRecording } from '../src/host/activity.ts';
import { CallError } from '../src/host/http.ts';
import { appSurface } from '../src/host/surface.ts';
import { undoCall, undoProblems } from '../src/host/undo.ts';

const surface = JSON.parse(await readFile(new URL('../surfaces/tasklet.json', import.meta.url), 'utf8')) as Surface;

const write = (scopes: string[], binding: Record<string, unknown> = {}): Capability => ({
	kind: 'write',
	input: { type: 'object', properties: { id: { type: 'string' }, url: { type: 'string' } } },
	output: { type: 'object' },
	scopes,
	binding,
});

describe('undo', () => {
	it('takes the reverse call’s input from the original input or its answer', () => {
		const complete = surface.capabilities['tasks.complete'];
		expect(undoCall(complete, { id: 't2' }, { id: 't2', status: 'done' })).toEqual({ capability: 'tasks.reopen', input: { id: 't2' } });
		const close = write(['tabs:write'], { undo: { capability: 'open', input: { url: { output: '/url' } } } });
		expect(undoCall(close, { id: 3 }, { url: 'https://example.com/' })).toEqual({ capability: 'open', input: { url: 'https://example.com/' } });
		// A field the reverse needs and the answer lacks: no undo, rather than a wrong one.
		expect(undoCall(close, { id: 3 }, {})).toBeUndefined();
		expect(undoCall(surface.capabilities['tasks.reopen'], { id: 't2' }, {})).toBeUndefined();
	});

	it('never needs more than the original: a reverse is a write within its scopes, taking fields it has', () => {
		expect(undoProblems(surface.capabilities)).toEqual([]);
		expect(
			undoProblems({
				close: write(['tabs:write'], { undo: { capability: 'wider', input: { id: { input: 'id' } } } }),
				wider: write(['tabs:write', 'history:write']),
				gone: write(['a'], { undo: { capability: 'missing', input: {} } }),
				odd: write(['a'], { undo: { capability: 'close', input: { color: { input: 'id' } } } }),
			}),
		).toEqual([
			'The undo of "close" needs history:write, which "close" does not.',
			'The undo of "gone" names "missing", which is not a write capability.',
			'The undo of "odd" needs tabs:write, which "odd" does not.',
			'The undo of "odd" sets "color", which "close" does not take.',
		]);
		const invalid = structuredClone(tasklet);
		invalid.capabilities['tasks.reopen']!.scopes = ['tasks.status:write', 'members:read'];
		expect(() => appSurface(invalid)).toThrow('needs members:read');
	});
});

describe('the activity log', () => {
	const where = { customization: 'my-tasks', title: 'My open tasks', source: { kind: 'view' as const }, surface, origin: 'http://127.0.0.1:4490' };

	it('records writes and anything that did not go through, not reads that did', () => {
		expect(worthRecording({ capability: 'tasks.list', kind: 'read', input: {}, outcome: 'ok' })).toBe(false);
		expect(worthRecording({ capability: 'tasks.list', kind: 'read', input: {}, outcome: 'failed', code: 'graft_drift' })).toBe(true);
		expect(worthRecording({ capability: 'members.list', kind: 'read', input: {}, outcome: 'refused', code: 'graft_capability_not_in_build' })).toBe(true);
		expect(worthRecording({ capability: 'tasks.complete', kind: 'write', input: { id: 't1' }, outcome: 'ok' })).toBe(true);
	});

	it('keeps how to undo a write that went through, and only that', () => {
		const done = activityFrom({ capability: 'tasks.complete', kind: 'write', input: { id: 't2' }, outcome: 'ok', output: { id: 't2' } }, where, Date.UTC(2026, 10, 19));
		expect(done).toMatchObject({ at: '2026-11-19T00:00:00.000Z', surface: surface.hash, origin: where.origin, description: 'Marks a task done.', undo: { capability: 'tasks.reopen', input: { id: 't2' } } });
		expect(undoRefusal(done, surface)).toBeUndefined();
		const failed = activityFrom({ capability: 'tasks.complete', kind: 'write', input: { id: 't2' }, outcome: 'failed', code: 'host_forbidden' }, where);
		expect(failed.undo).toBeUndefined();
		expect(undoRefusal(failed, surface)).toBe('There is nothing to undo there.');
		expect(undoRefusal({ ...done, undo: { ...done.undo!, done: '2026-11-19T00:01:00.000Z' } }, surface)).toBe('It was undone already.');
		// Undone on the surface the call was made on, or not at all.
		expect(undoRefusal(done, { ...surface, hash: 'sha256:other' })).toBe('The extension no longer has the version of the app this was done on.');
	});

	it('does not offer again an undo whose outcome was not saved', () => {
		const done = activityFrom({ capability: 'tasks.complete', kind: 'write', input: { id: 't2' }, outcome: 'ok', output: { id: 't2' } }, where);
		expect(undoRefusal({ ...done, undo: { ...done.undo!, started: '2026-11-21T00:00:00.000Z' } }, surface)).toBe('It is being undone, or was, and the result could not be saved.');
	});

	it('shows web addresses without their query and fragment, which can hold tokens', () => {
		expect(describeActivity({ capability: 'tabs.open', description: 'Opens a web page.', input: { url: 'https://example.com/reset?token=secret#x' } })).toBe('Opens a web page. ({"url":"https://example.com/reset…"})');
		expect(describeActivity({ capability: 'tabs.open', input: { url: 'https://example.com/a' } })).toBe('tabs.open ({"url":"https://example.com/a"})');
	});

	it('stores inputs shortened, and keeps the full address only where Undo needs it', async () => {
		const chrome = JSON.parse(await readFile(new URL('../surfaces/chrome.json', import.meta.url), 'utf8')) as Surface;
		const at = { customization: 'stale-tabs', title: 'Stale tabs', source: { kind: 'view' as const }, surface: chrome };
		const url = 'https://example.com/reset?token=secret';
		const closed = activityFrom({ capability: 'tabs.close', kind: 'write', input: { id: 3 }, outcome: 'ok', output: { id: 3, url } }, at);
		expect(closed.undo).toEqual({ capability: 'tabs.open', input: { url } });
		const reopened = activityFrom({ capability: 'tabs.open', kind: 'write', input: { url }, outcome: 'ok', output: { id: 4, url } }, { ...at, source: { kind: 'undo', of: closed.id } });
		expect(reopened.input).toEqual({ url: 'https://example.com/reset…' });
		expect(JSON.stringify(reopened)).not.toContain('secret');
	});

	it('lets an undo be tried again only after a refusal known to change nothing', () => {
		const error = (code: string) => new CallError(code, code);
		for (const code of ['graft_invalid_input', 'graft_not_granted', 'host_forbidden', 'host_unauthorized', 'host_not_found']) {
			expect(changedNothing(error(code))).toBe(true);
		}
		// A 500 can come after the change took effect; so can a timeout or an answer that does not match.
		for (const code of ['host_error', 'host_unreachable', 'graft_drift']) {
			expect(changedNothing(error(code))).toBe(false);
		}
		expect(changedNothing(new Error('anything'))).toBe(false);
	});

	it('keeps the latest entries', () => {
		let log = [] as ReturnType<typeof activityFrom>[];
		for (let i = 0; i < 5; i++) {
			log = appendActivity(log, activityFrom({ capability: 'tasks.complete', kind: 'write', input: { id: `t${i}` }, outcome: 'ok', output: {} }, where), 3);
		}
		expect(log.map((e) => (e.input as { id: string }).id)).toEqual(['t2', 't3', 't4']);
	});
});
