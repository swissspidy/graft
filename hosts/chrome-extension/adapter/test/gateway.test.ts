import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CustomizationBundle, Surface } from '@swissspidy/graft-core';
import { startTasklet, type TaskletServer } from '../../fixtures/tasklet/server.ts';
import { act, fromBundle, gatewayCall, mountsFor, renderMount, unservable, type Installed, type PageContext } from '../src/host/gateway.ts';
import type { Fetch } from '../src/host/http.ts';
import type { ViewNode } from '../src/host/a2ui.ts';
import '../src/host/a2ui.ts';

const surface = JSON.parse(await readFile(new URL('../surfaces/tasklet.json', import.meta.url), 'utf8')) as Surface;
const bundle = JSON.parse(await readFile(new URL('../../../../examples/chrome-extension/bundles/my-tasks.json', import.meta.url), 'utf8')) as CustomizationBundle;

let app: TaskletServer;
beforeAll(async () => {
	app = await startTasklet();
});
afterAll(() => app.close());

/** A fetch signed in to the fixture app as a user, like the extension's with the person's cookies. */
async function session(user: string): Promise<Fetch> {
	const response = await fetch(`${app.url}/login?as=${user}`, { redirect: 'manual' });
	const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
	return (url, init) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } });
}

async function approved(): Promise<Installed> {
	const { installed, problems } = await fromBundle(bundle, surface, 'test');
	expect(problems).toEqual([]);
	return { ...installed!, grant: [...installed!.manifest.permissions] };
}

describe('the gateway', () => {
	it('installs a verified bundle waiting for approval, and serves it once approved', async () => {
		const { installed } = await fromBundle(bundle, surface, 'test');
		expect(installed?.grant).toBeNull();
		expect(await unservable(installed!, surface)).toBe('It is waiting for approval.');
		expect(await unservable(await approved(), surface)).toBeUndefined();
	});

	it('refuses bundles that are not verified for this surface', async () => {
		const other = { ...surface, hash: 'sha256:'.padEnd(71, '0') };
		expect((await fromBundle(bundle, other, 'test')).problems).toEqual(['The bundle has no build for this version of the app.']);
		const failed = { ...bundle, builds: bundle.builds.map((b) => ({ ...b, verification: { ...b.verification, passed: false } })) };
		expect((await fromBundle(failed, surface, 'test')).problems).toEqual(['Its build was not verified for this spec and this version of the app.']);
	});

	it('mounts only on the app’s pages that have the slot', async () => {
		const installed = await approved();
		expect(await mountsFor([installed], surface, `${app.url}/projects/launch`)).toHaveLength(1);
		expect(await mountsFor([installed], surface, `${app.url}/`)).toHaveLength(0);
		expect(await mountsFor([installed], surface, 'https://example.com/projects/launch')).toHaveLength(0);
	});

	it('refuses calls the build does not make, the grant does not cover, or with invalid input', async () => {
		const installed = await approved();
		const fetch = await session('ada');
		const call = gatewayCall(installed, surface, app.url, fetch);
		await expect(call('members.list', {})).rejects.toMatchObject({ code: 'graft_capability_not_in_build' });
		await expect(call('tasks.list', { project: 'launch', extra: 1 })).rejects.toMatchObject({ code: 'graft_invalid_input' });
		const narrow = gatewayCall({ ...installed, grant: ['tasks:read'] }, surface, app.url, fetch);
		await expect(narrow('tasks.complete', { id: 't1' })).rejects.toMatchObject({ code: 'graft_not_granted' });
		const widened = { ...installed, build: { ...installed.build, data: { ...installed.build.data, members: { call: 'members.list', input: {} } } } };
		expect(await unservable(widened, surface)).toBe('It needs permissions that were not approved: members:read.');
		expect(app.log().filter((line) => line.includes('/api/members') || line.startsWith('POST'))).toEqual([]);
	});

	it('renders for the viewer and acts only on buttons the render offers', async () => {
		const installed = await approved();
		const url = `${app.url}/projects/launch`;
		const [mount] = await mountsFor([installed], surface, url);
		const guest: PageContext = { surface, url, fetch: await session('grace') };
		const shown = await renderMount(guest, mount!);
		const flat = (nodes: ViewNode[]): ViewNode[] => nodes.flatMap((node) => (node.type === 'group' ? flat(node.children) : [node]));
		const table = flat(shown.view).find((node) => node.type === 'table');
		expect(table).toMatchObject({ rows: [{ cells: [{ text: 'Proofread FAQ' }, { text: '—' }], buttons: [] }] });
		expect(await act(guest, mount!, 'my-tasks:t0:0:t5')).toMatchObject({ notice: { tone: 'error', text: 'That action is not available.' } });

		const member: PageContext = { surface, url, fetch: await session('ada') };
		const rendered = await renderMount(member, mount!);
		const key = rendered.actions.find((a) => a.available && a.key.endsWith(':t2'))!.key;
		// The same shape as the guest's refused key above: only availability differs.
		expect(key).toBe('my-tasks:t0:0:t2');
		const done = await act(member, mount!, key);
		expect(done.notice).toEqual({ tone: 'success', text: 'Marked done.' });
		expect(JSON.stringify(done.view)).not.toContain('Check redirects');
		expect(app.log()).toContain('POST /api/tasks/t2/complete');
	});

	it('reports answers that no longer match as drift', async () => {
		const installed = await approved();
		const url = `${app.url}/projects/launch`;
		const [mount] = await mountsFor([installed], surface, url);
		const drift: string[] = [];
		app.setVersion(3);
		try {
			const rendered = await renderMount({ surface, url, fetch: await session('ada'), onDrift: (capability, details) => drift.push(`${capability}: ${details[0]}`) }, mount!);
			expect(rendered.view[0]).toMatchObject({ type: 'notice', tone: 'error' });
			expect(drift).toEqual(['tasks.list: /tasks/0 is missing "due"']);
		} finally {
			app.setVersion(1);
		}
	});
});
