import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { hashSurface, validateBuild, validateSurface, type Build, type CustomizationBundle, type Spec, type Surface } from '@swissspidy/graft-core';
import { validateSpec } from '@swissspidy/graft-core';
import { chromeSurface } from '../src/browser/surface.ts';
import { listTabs, tabsPerform, type Tab } from '../src/browser/tabs.ts';
import { extensionManifest } from '../src/extension/manifest.ts';
import { act, fromBundle, renderMount, type Context, type Installed } from '../src/host/gateway.ts';
import { FakeTabs, verifyInChrome } from '../src/node/chrome-sandbox.ts';
import type { ViewNode } from '../src/host/a2ui.ts';
import '../src/host/a2ui.ts';

const surface = JSON.parse(await readFile(new URL('../surfaces/chrome.json', import.meta.url), 'utf8')) as Surface;
const tasklet = JSON.parse(await readFile(new URL('../surfaces/tasklet.json', import.meta.url), 'utf8')) as Surface;
const read = (path: string) => readFile(new URL(`../../../../examples/browser/${path}`, import.meta.url), 'utf8');

const DAY = 24 * 60 * 60 * 1000;

describe('the browser surface', () => {
	it('is generated from the extension’s code, and hashes to its hash', async () => {
		expect((await validateSurface(surface)).ok).toBe(true);
		expect(surface.hash).toBe(await hashSurface(surface));
		expect(await chromeSurface()).toEqual(surface);
	});

	it('lists tabs least recently used first, filtered by pinned and by how long they were unused', () => {
		const now = Date.now();
		const tabs: Tab[] = [
			{ id: 1, title: 'Week old', url: 'https://a.example/', pinned: false, active: false, lastAccessed: now - 8 * DAY },
			{ id: 2, title: 'Month old, pinned', url: 'https://b.example/', pinned: true, active: false, lastAccessed: now - 30 * DAY },
			{ id: 3, title: 'Now', url: 'https://c.example/', pinned: false, active: true, lastAccessed: now },
		];
		expect(listTabs(tabs, {}, now).map((t) => t.id)).toEqual([2, 1, 3]);
		expect(listTabs(tabs, { pinned: false, unusedForDays: 7 }, now).map((t) => t.id)).toEqual([1]);
		// The tab in front is in use, however long ago it was brought there (Chrome does not update lastAccessed while it stays).
		expect(listTabs(tabs, { unusedForDays: 7 }, now + 30 * DAY).map((t) => t.id)).toEqual([2, 1]);
		expect(listTabs(tabs, {}, now + 30 * DAY).map((t) => t.id)).toEqual([2, 1, 3]);
	});

	it('records the tab brought to the front as used now, and only that one', async () => {
		const tabs = new FakeTabs();
		tabs.seed([{ title: 'Old', unused_days: 10 }, { title: 'Other', unused_days: 10, active: true }], Date.now());
		const perform = tabsPerform(tabs);
		await perform('tabs.focus', surface.capabilities['tabs.focus']!, { id: 1 });
		const [old, other] = await tabs.query();
		expect(old).toMatchObject({ active: true });
		expect(Date.now() - old!.lastAccessed!).toBeLessThan(1000);
		expect(other).toMatchObject({ active: false });
		expect(Date.now() - other!.lastAccessed!).toBeGreaterThan(9 * DAY);
	});

	it('opens web pages only, and answers a closed tab with what it takes to open it again', async () => {
		const tabs = new FakeTabs();
		tabs.seed([{ title: 'Old', url: 'https://old.example/' }], Date.now());
		const perform = tabsPerform(tabs);
		await expect(perform('tabs.open', { ...surface.capabilities['tabs.open']!, input: {} }, { url: 'javascript:alert(1)' })).rejects.toMatchObject({ code: 'graft_invalid_input' });
		const closed = await perform('tabs.close', surface.capabilities['tabs.close']!, { id: 1 });
		expect(closed).toMatchObject({ title: 'Old', url: 'https://old.example/' });
		await expect(perform('tabs.close', surface.capabilities['tabs.close']!, { id: 1 })).rejects.toMatchObject({ code: 'host_not_found' });
	});
});

describe('the stale-tabs example', () => {
	it('validates, passes its checks in an in-memory browser, and installs from its bundle', async () => {
		const source = await read('specs/stale-tabs.md');
		const { spec } = validateSpec(source, { surface });
		const build = JSON.parse(await read('builds/stale-tabs.json')) as Build;
		expect((await validateBuild(build, surface)).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
		const [verification] = await verifyInChrome([{ build, spec: spec as Spec, surface }]);
		// Every check ran, one result per check, and each passed.
		expect(verification!.results.map((r) => r.criterion)).toEqual(build.checks.map((c) => c.criterion));
		expect(verification!.results.length).toBe(9);
		expect(verification!.results.filter((r) => !r.passed)).toEqual([]);
		const bundle = JSON.parse(await read('bundles/stale-tabs.json')) as CustomizationBundle;
		expect((await fromBundle(bundle, surface, 'test')).problems).toEqual([]);
		// It is for the browser, not for an app.
		expect((await fromBundle(bundle, tasklet, 'test')).problems).toEqual(['The bundle’s spec does not validate against this app.']);
	});

	it('draws in the side panel and closes a tab through the gateway', async () => {
		const bundle = JSON.parse(await read('bundles/stale-tabs.json')) as CustomizationBundle;
		const { installed } = await fromBundle(bundle, surface, 'test');
		const approved: Installed = { ...installed!, grant: ['tabs:read', 'tabs:write'] };
		const tabs = new FakeTabs();
		tabs.seed([{ title: 'Old', unused_days: 10 }, { title: 'Fresh' }], Date.now());
		const writes: string[] = [];
		const context: Context = { surface, perform: tabsPerform(tabs), role: async () => undefined, onCall: (c) => c.kind === 'write' && writes.push(`${c.capability} ${c.outcome}`) };
		const mount = { installed: approved, slot: 'side-panel', props: {} };
		const flat = (nodes: ViewNode[]): ViewNode[] => nodes.flatMap((node) => (node.type === 'group' ? flat(node.children) : [node]));
		const rendered = await renderMount(context, mount);
		expect(flat(rendered.view).find((n) => n.type === 'table')).toMatchObject({ rows: [{ cells: [{ text: 'Old' }, { text: '10 days ago' }] }] });
		const key = rendered.actions.find((a) => a.available)!.key;
		const done = await act(context, mount, key);
		expect(done.notice?.tone).toBe('success');
		expect(tabs.all().map((t) => t.title)).toEqual(['Fresh']);
		expect(writes).toEqual(['tabs.close ok']);
		// Without "tabs:write" approved there is no Close button, and a forged key does nothing.
		tabs.seed([{ title: 'Older', unused_days: 20 }], Date.now());
		// The key of Older's Close button, as an approved render offers it: a real row, not one already gone.
		const olderKey = (await renderMount(context, mount)).actions.find((a) => a.available)!.key;
		const readOnly = { ...mount, installed: { ...approved, grant: ['tabs:read'] } };
		expect((await renderMount(context, readOnly)).actions.filter((a) => a.available)).toEqual([]);
		expect(await act(context, readOnly, olderKey)).toMatchObject({ notice: { tone: 'error', text: 'That action is not available.' } });
		expect(tabs.all().map((t) => t.title)).toEqual(['Fresh', 'Older']);
		expect(writes).toEqual(['tabs.close ok']);
	});
});

describe('the extension manifest with the browser surface', () => {
	it('asks for the tabs, side panel and alarms permissions its surface needs, and the newer Chrome', () => {
		const manifest = extensionManifest([tasklet, surface], '0.0.1');
		expect(manifest.permissions).toEqual(['alarms', 'sidePanel', 'storage', 'tabs']);
		expect(manifest.host_permissions).toEqual(['http://127.0.0.1/*']);
		expect(manifest.side_panel).toEqual({ default_path: 'sidepanel.html' });
		expect(manifest.minimum_chrome_version).toBe('121');
		expect(extensionManifest([tasklet], '0.0.1').permissions).toEqual(['storage']);
	});
});
