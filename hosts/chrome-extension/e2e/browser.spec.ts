import type { Page, Worker } from '@playwright/test';
import { expect, test } from './fixtures.ts';

/**
 * The browser's own surface end to end: the "Stale tabs" customization in
 * the extension's side panel, its trigger closing tabs on its own, and
 * reopening what it closed from the activity log. Tabs cannot be made old,
 * so the trigger runs on a clock eight days ahead, as checks do.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Runs the triggers that are due at a time, in the service worker (its `graft` test hook). */
const tick = (worker: Worker, now: number) =>
	worker.evaluate((now) => (globalThis as unknown as { graft: { tick(now: number): Promise<unknown[]> } }).graft.tick(now), now);

/** Opens a page of the fixture app in a tab of its own, and returns the page. */
async function tab(context: import('@playwright/test').BrowserContext, url: string): Promise<Page> {
	const page = await context.newPage();
	await page.goto(url);
	return page;
}

test('the side panel shows nothing before approval, then the approved customization', async ({ context, extensionId, approve }) => {
	const panel = await tab(context, `chrome-extension://${extensionId}/sidepanel.html`);
	await expect(panel.getByText('Nothing here yet.')).toBeVisible();
	await approve('Stale tabs');
	await panel.reload();
	const box = panel.getByRole('region', { name: 'Stale tabs' });
	// Every tab here was opened just now.
	await expect(box.getByText('No stale tabs')).toBeVisible();
});

test('the options page says when it runs on its own and what it may do, and a dry run changes nothing', async ({ context, extensionId, approve, app }) => {
	await approve('Stale tabs');
	const keep = await tab(context, `${app.url}/login`);
	const options = await tab(context, `chrome-extension://${extensionId}/options.html`);
	const section = options.locator('section', { has: options.getByRole('heading', { name: 'Stale tabs' }) });
	const trigger = section.locator('li[data-trigger="close-stale"]');
	await expect(trigger).toContainText('Every day, at most 10 at a time (close-stale). It may: See the titles and addresses of your open tabs; Open, close and switch between your tabs.');
	await expect(trigger.locator('.trigger-state')).toContainText('Running; next run');
	await trigger.getByRole('button', { name: 'Dry run' }).click();
	await expect(options.locator('.runs li').first()).toContainText('Dry run: would act on 0 of 0.');
	await trigger.getByRole('button', { name: 'Pause' }).click();
	await expect(trigger.locator('.trigger-state')).toHaveText('Paused: Paused by you.');
	await expect(trigger.getByRole('button', { name: 'Run now' })).toHaveCount(0);
	expect(keep.isClosed()).toBe(false);
});

test('a week later, the trigger closes unpinned tabs on its own, and a closed tab can be opened again', async ({ context, extensionId, approve, app, worker }) => {
	await approve('Stale tabs');
	for (const page of context.pages()) {
		await page.close();
	}
	const pinned = await tab(context, `${app.url}/login?pinned`);
	const stale = await tab(context, `${app.url}/login?stale`);
	// The tab in front is in use however long ago it was brought there: the stale one goes to the back.
	await pinned.bringToFront();
	await worker.evaluate(async (url) => {
		const [found] = await chrome.tabs.query({ url });
		await chrome.tabs.update(found!.id!, { pinned: true });
	}, pinned.url());

	// Not due yet: it waits a day after approval.
	expect(await tick(worker, Date.now() + 60 * 60 * 1000)).toEqual([]);
	const closing = stale.waitForEvent('close');
	const runs = await tick(worker, Date.now() + 8 * DAY);
	expect(runs).toHaveLength(1);
	await closing;
	expect(pinned.isClosed()).toBe(false);

	const options = await tab(context, `chrome-extension://${extensionId}/options.html`);
	await expect(options.locator('.runs li').first()).toContainText('Ran on schedule: acted on 1 of 1');
	const entry = options.locator('.activity li').filter({ hasText: 'Closes a tab.' });
	await expect(entry).toContainText('on its own (close-stale)');
	const reopened = context.waitForEvent('page');
	await entry.getByRole('button', { name: 'Undo' }).click();
	await expect((await reopened).url()).toContain('/login?stale');
	await expect(entry).toContainText('Undone');
	// Once nothing can be undone any more, the log keeps no full address with its query.
	const log = await worker.evaluate(async () => JSON.stringify((await chrome.storage.local.get('activity')).activity));
	expect(log).toContain('/login…');
	expect(log).not.toContain('login?stale');
});

test('pausing every trigger stops them all', async ({ context, extensionId, approve, app, worker }) => {
	await approve('Stale tabs');
	const stale = await tab(context, `${app.url}/login?stale`);
	const options = await tab(context, `chrome-extension://${extensionId}/options.html`);
	await options.getByRole('button', { name: 'Pause all' }).click();
	await expect(options.getByText('Nothing runs on its own')).toBeVisible();
	expect(await tick(worker, Date.now() + 8 * DAY)).toEqual([]);
	expect(stale.isClosed()).toBe(false);
});

test('a preview of a side panel customization is drawn there, read-only, until it ends', async ({ context, extensionId }) => {
	const options = await tab(context, `chrome-extension://${extensionId}/options.html`);
	const section = options.locator('section', { has: options.getByRole('heading', { name: 'Stale tabs' }) });
	await expect(section.locator('.preview')).toContainText('It may read: See the titles and addresses of your open tabs.');
	await section.getByRole('button', { name: 'Preview' }).click();
	const panel = await tab(context, `chrome-extension://${extensionId}/sidepanel.html`);
	const box = panel.getByRole('region', { name: 'Stale tabs (preview)' });
	await expect(box.getByText('No stale tabs')).toBeVisible();
	await section.getByRole('button', { name: 'Stop the preview' }).click();
	await expect(section.getByRole('button', { name: 'Preview' })).toBeVisible();
	await panel.reload();
	await expect(panel.getByText('Nothing here yet.')).toBeVisible();
});

test('a trigger paused while it runs stays paused, and does not run twice at once', async ({ approve, worker, extensionId }) => {
	await approve('Stale tabs');
	const result = await worker.evaluate(async (later) => {
		type Graft = { runTrigger(id: string, trigger: string, options: { now: number }): Promise<unknown>; handle(message: unknown, sender: unknown): Promise<unknown> };
		const graft = (globalThis as unknown as { graft: Graft }).graft;
		const options = { id: chrome.runtime.id, url: chrome.runtime.getURL('options.html'), frameId: 0 };
		const [first, second, pause] = await Promise.allSettled([
			graft.runTrigger('stale-tabs', 'close-stale', { now: later }),
			graft.runTrigger('stale-tabs', 'close-stale', { now: later }),
			graft.handle({ type: 'trigger', id: 'stale-tabs', trigger: 'close-stale', op: 'pause' }, options),
		]);
		const states = (await chrome.storage.local.get('triggers')).triggers as Record<string, { paused?: { reason: string }; lastRun?: number }>;
		return {
			first: first.status,
			second: second.status === 'rejected' ? (second.reason as Error).message : 'ran',
			pause: pause.status,
			state: states['stale-tabs/close-stale'],
		};
	}, Date.now() + 8 * 24 * 60 * 60 * 1000);
	expect(result.first).toBe('fulfilled');
	expect(result.second).toBe('It is running already.');
	expect(result.pause).toBe('fulfilled');
	// Whichever finished first, the run's save kept the pause.
	expect(result.state).toMatchObject({ paused: { reason: 'Paused by you.' } });
	expect(result.state?.lastRun).toBeGreaterThan(0);
	expect(extensionId).toBeTruthy();
});
