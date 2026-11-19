import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { CustomizationBundle, Surface } from '@swissspidy/graft-core';
import { tabsPerform } from '../src/browser/tabs.ts';
import { fromBundle, type CallRecord, type Installed } from '../src/host/gateway.ts';
import { dueTriggers, nextRun, PAUSE_AFTER_FAILURES, runInstalledTrigger, stateFor, unrunnable } from '../src/host/runner.ts';
import { FakeTabs } from '../src/node/chrome-sandbox.ts';
import '../src/host/a2ui.ts';

const surface = JSON.parse(await readFile(new URL('../surfaces/chrome.json', import.meta.url), 'utf8')) as Surface;
const bundle = JSON.parse(await readFile(new URL('../../../../examples/browser/bundles/stale-tabs.json', import.meta.url), 'utf8')) as CustomizationBundle;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const approvedAt = '2026-11-19T10:00:00.000Z';

async function approved(): Promise<Installed> {
	const { installed, problems } = await fromBundle(bundle, surface, 'test');
	expect(problems).toEqual([]);
	return { ...installed!, grant: [...installed!.manifest.permissions], triggerGrants: { 'close-stale': ['tabs:read', 'tabs:write'] }, approvedAt };
}

function browser(now: number): FakeTabs {
	const tabs = new FakeTabs();
	tabs.seed(
		[
			{ title: 'Old', unused_days: 10 },
			{ title: 'Old pinned', unused_days: 30, pinned: true },
			{ title: 'Fresh', unused_days: 1 },
		],
		now,
	);
	return tabs;
}

describe('schedules', () => {
	it('runs an interval after the last run, and days "at" a time on the day the interval lands on', () => {
		const from = new Date(2026, 10, 19, 10, 30).getTime();
		expect(nextRun({ every: '6h' }, from, true)).toBe(from + 6 * HOUR);
		expect(nextRun({ every: '1d' }, from, false)).toBe(from + DAY);
		// Never ran: the first 09:00 after it was approved, which is tomorrow's.
		expect(nextRun({ every: '1d', at: '09:00' }, from, false)).toBe(new Date(2026, 10, 20, 9, 0).getTime());
		expect(nextRun({ every: '1d', at: '11:00' }, from, false)).toBe(new Date(2026, 10, 19, 11, 0).getTime());
		// Ran late (the browser was closed at 09:00): the next one is still at 09:00, two days on.
		expect(nextRun({ every: '2d', at: '09:00' }, from, true)).toBe(new Date(2026, 10, 21, 9, 0).getTime());
	});

	it('waits for the first slot after approval, then runs once per interval', async () => {
		const installed = await approved();
		const at = Date.parse(approvedAt);
		expect(await dueTriggers([installed], () => surface, {}, at + HOUR)).toEqual([]);
		const due = await dueTriggers([installed], () => surface, {}, at + DAY);
		expect(due.map((d) => d.trigger)).toEqual(['close-stale']);
		const state = { ...stateFor(installed, 'close-stale', {}), lastRun: at + DAY, nextRun: at + 2 * DAY };
		expect(await dueTriggers([installed], () => surface, { 'stale-tabs/close-stale': state }, at + DAY + HOUR)).toEqual([]);
		expect(await dueTriggers([installed], () => surface, { 'stale-tabs/close-stale': { ...state, paused: { at: '', reason: 'Paused by you.' } } }, at + 3 * DAY)).toEqual([]);
		// A new spec version starts afresh.
		expect(stateFor({ ...installed, specHash: 'sha256:new' }, 'close-stale', { 'stale-tabs/close-stale': state })).toEqual({ specHash: 'sha256:new', failures: 0, handled: [] });
	});
});

describe('running a trigger', () => {
	it('closes what its build says through the gateway, and reports every call', async () => {
		const installed = await approved();
		const now = Date.now();
		const tabs = browser(now);
		const calls: CallRecord[] = [];
		const { run, state } = await runInstalledTrigger({ installed, surface, trigger: 'close-stale', perform: tabsPerform(tabs, () => now), state: stateFor(installed, 'close-stale', {}), now, onCall: (c) => calls.push(c) });
		expect(run).toMatchObject({ status: 'ok', targets: 1, matched: 1, calls: [{ target: { title: 'Old' }, ok: true }] });
		expect(tabs.all().map((t) => t.title)).toEqual(['Old pinned', 'Fresh']);
		expect(calls.map((c) => `${c.capability} ${c.outcome}`)).toEqual(['tabs.list ok', 'tabs.close ok']);
		expect(state).toMatchObject({ lastRun: now, nextRun: now + DAY, failures: 0 });
	});

	it('changes nothing in a dry run', async () => {
		const installed = await approved();
		const now = Date.now();
		const tabs = browser(now);
		const before = stateFor(installed, 'close-stale', {});
		const { run, state } = await runInstalledTrigger({ installed, surface, trigger: 'close-stale', perform: tabsPerform(tabs, () => now), state: before, now, dryRun: true });
		expect(run).toMatchObject({ status: 'dry-run', calls: [{ target: { title: 'Old' } }] });
		expect(tabs.all()).toHaveLength(3);
		expect(state).toBe(before);
	});

	it('does not run on a grant narrower than its build needs, and refuses its calls if asked to', async () => {
		const narrow = { ...(await approved()), triggerGrants: { 'close-stale': ['tabs:read'] } };
		expect(await unrunnable(narrow, surface, 'close-stale')).toBe('It needs permissions that were not approved for it: tabs:write.');
		expect(await unrunnable({ ...narrow, grant: null }, surface, 'close-stale')).toBe('It is waiting for approval.');
		const now = Date.now();
		const tabs = browser(now);
		const calls: CallRecord[] = [];
		const { run } = await runInstalledTrigger({ installed: narrow, surface, trigger: 'close-stale', perform: tabsPerform(tabs, () => now), state: stateFor(narrow, 'close-stale', {}), now, onCall: (c) => calls.push(c) });
		expect(run.calls[0]).toMatchObject({ ok: false });
		expect(calls.at(-1)).toMatchObject({ capability: 'tabs.close', outcome: 'refused', code: 'graft_not_granted' });
		expect(tabs.all()).toHaveLength(3);
	});

	it(`pauses itself after ${PAUSE_AFTER_FAILURES} failed runs in a row`, async () => {
		const installed = await approved();
		const broken = () => Promise.reject(new Error('The browser is gone.'));
		let state = stateFor(installed, 'close-stale', {});
		for (let i = 0; i < PAUSE_AFTER_FAILURES; i++) {
			({ state } = await runInstalledTrigger({ installed, surface, trigger: 'close-stale', perform: broken, state, now: Date.now() }));
		}
		expect(state.failures).toBe(PAUSE_AFTER_FAILURES);
		expect(state.paused?.reason).toMatch(/^It failed 3 times in a row: Reading the targets failed/);
	});
});
