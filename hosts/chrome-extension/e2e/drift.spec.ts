import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { startTasklet, type TaskletServer, type TaskletVersion } from '../fixtures/tasklet/server.ts';
import { checkDrift, startTaskletSandbox, taskletProbes, upgradeAfterDrift, type Build, type DriftReport, type Surface } from '../adapter/src/node/index.ts';

/**
 * Drift detection feeding the upgrade ladder: the fixture app changes the
 * way third-party apps do (a renamed test id, a removed toolbar, a renamed
 * API field), the probe reports which slots and capabilities broke, and
 * each build goes up the ladder from the declared surface to the observed
 * one, verified in a sandbox of the changed app.
 */

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');
const surface = JSON.parse(await read('../adapter/surfaces/tasklet.json')) as Surface;
const build = JSON.parse(await read('../../../examples/chrome-extension/builds/my-tasks.json')) as Build;
const source = await read('../../../examples/chrome-extension/specs/my-tasks.md');
const grant = ['tasks:read', 'tasks.status:write'];

let app: TaskletServer;
test.beforeEach(async () => {
	app = await startTasklet();
});
test.afterEach(() => app.close());

async function drift(version: TaskletVersion) {
	app.setVersion(version);
	return checkDrift(surface, [build], { url: app.url, probes: taskletProbes });
}

async function upgrade(version: TaskletVersion, report: DriftReport) {
	const sandbox = await startTaskletSandbox({ version });
	try {
		return await upgradeAfterDrift({ report, from: surface, build, source, grant, sandbox });
	} finally {
		await sandbox.close();
	}
}

test('the app as described: no drift, and the observed surface is the declared one', async () => {
	const report = await drift(1);
	expect(report.drifted).toBe(false);
	expect(report.observed).toBe(surface.fingerprint);
	expect(report.surface.hash).toBe(surface.hash);
	expect(report.builds).toEqual([{ spec: 'my-tasks', start: 'reverify', changes: [] }]);
});

test('a renamed test id: the slot is re-anchored by its landmark, and the build survives re-verification', async () => {
	const report = await drift(2);
	expect(report.drifted).toBe(true);
	expect(report.slots['project.sidebar']).toMatchObject({ status: 'moved', via: 'landmark', selector: '[data-testid="details-pane"]' });
	expect(report.slots['project.toolbar']?.status).toBe('ok');
	expect(report.capabilities['tasks.list']?.status).toBe('ok');
	expect(report.capabilities['tasks.complete']?.status).toBe('unprobed');
	expect(report.surface.hash).not.toBe(surface.hash);
	// The slot's contract (what it provides) did not change, only where it is: nothing the build uses changed.
	expect(report.builds).toEqual([{ spec: 'my-tasks', start: 'reverify', changes: [] }]);

	const result = await upgrade(2, report);
	expect(result.outcome).toBe('survived');
	expect(result.build?.surface.hash).toBe(report.surface.hash);
});

test('a removed toolbar and a renamed API field: the build has to be regenerated', async () => {
	const report = await drift(3);
	expect(report.slots['project.toolbar']).toMatchObject({ status: 'broken' });
	expect(report.capabilities['tasks.list']).toMatchObject({ status: 'broken', problems: ['/tasks/[] is missing "due"'], undeclared: ['/tasks/[]/dueDate'] });
	expect(report.surface.slots['project.toolbar']).toBeUndefined();
	expect(report.builds).toEqual([{ spec: 'my-tasks', start: 'regenerate', changes: [{ kind: 'capability', symbol: 'tasks.list', change: 'changed' }] }]);

	// Without a model to regenerate it, the ladder stops there: the customization is suspended, not served broken.
	const result = await upgrade(3, report);
	expect(result.outcome).toBe('failed');
	expect(result.path.map((step) => step.state)).toContain('regenerate');
});
