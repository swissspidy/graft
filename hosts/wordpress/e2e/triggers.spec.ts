import { expect, test, type Page } from '@playwright/test';
import { login } from './login.ts';

/**
 * Triggers (ADR 0010) in real wp-admin: the "Waiting too long" example is
 * seeded active, with its daily trigger and its trigger on publishing. An
 * administrator sees what runs on its own and as whom, tries it as a dry
 * run, pauses and runs it; publishing a post runs the other trigger from
 * WP-Cron, as the automation user. Runs after runtime.spec.ts (one
 * worker, files in order), whose pending posts it leaves alone.
 */
test.describe.configure({ mode: 'serial' });

const DAY = 24 * 60 * 60 * 1000;

const api = <T>(page: Page, options: { path: string; method?: string; data?: unknown }) =>
	page.evaluate((o) => window.wp.apiFetch(o), options) as Promise<T>;

const automation = (page: Page) => page.locator('[data-graft-automation]');
const row = (page: Page, trigger: string) => automation(page).locator(`[data-graft-trigger="waiting-too-long/${trigger}"]`);
const message = (page: Page) => automation(page).locator('[data-graft-trigger-message]');

let postId = 0;
const tagsOf = async (page: Page) => (await api<{ tags: number[] }>(page, { path: `/wp/v2/posts/${postId}?context=edit` })).tags;

test('administrators see what runs on its own, as whom, and what it may do', async ({ page }) => {
	await login(page, 'admin');
	// A post that has waited ten days (the seed created the tag).
	const date = new Date(Date.now() - 10 * DAY).toISOString().slice(0, 19);
	postId = (await api<{ id: number }>(page, { path: '/wp/v2/posts', method: 'POST', data: { title: 'Stuck in review', status: 'pending', date } })).id;

	await page.goto('/wp-admin/tools.php?page=graft-customizations');
	const card = page.locator('[data-graft-spec="waiting-too-long"]');
	const grant = card.locator('[data-graft-trigger-grant="flag-stale"]');
	await expect(grant).toContainText('every day at 09:00, at most 20 at a time');
	await expect(grant).toContainText('Change the categories, tags and other terms of posts you can edit (granted)');
	await expect(card.locator('[data-graft-trigger-grant="clear-on-publish"]')).toContainText('when a post is published');
	await expect(card).toContainText('as Graft automation: a user with no role of its own');
	await expect(card.locator('.graft-checks')).toContainText('and "flag-stale" runs on its own, then the run of "flag-stale" acts on 1 target');

	await expect(automation(page)).toContainText('as Graft automation');
	await expect(row(page, 'flag-stale')).toContainText('every day at 09:00, at most 20 per run, once per post');
	await expect(row(page, 'flag-stale')).toContainText('Active');
	await expect(row(page, 'clear-on-publish')).toContainText('On the event');
	await page.screenshot({ path: 'test-results/triggers.png', fullPage: true });
});

test('a dry run shows what would happen and changes nothing; a paused trigger does not run', async ({ page }) => {
	await login(page, 'admin');
	await page.goto('/wp-admin/tools.php?page=graft-customizations');
	await row(page, 'flag-stale').getByRole('button', { name: 'Dry run' }).click();
	await expect(message(page)).toContainText('Dry run: would act on 1 of');
	await expect(message(page)).toContainText('Stuck in review');
	expect(await tagsOf(page)).toEqual([]);

	await row(page, 'flag-stale').getByRole('button', { name: 'Pause' }).click();
	await expect(row(page, 'flag-stale')).toHaveAttribute('data-graft-paused', 'true');
	await expect(row(page, 'flag-stale')).toContainText('Paused by an administrator');
	await expect(row(page, 'flag-stale').getByRole('button', { name: 'Run now' })).toBeDisabled();
	await row(page, 'flag-stale').getByRole('button', { name: 'Resume' }).click();
	await expect(row(page, 'flag-stale')).toHaveAttribute('data-graft-paused', 'false');
});

test('run now tags the post as the automation user, and editors see it on their Dashboard', async ({ page }) => {
	await login(page, 'admin');
	await page.goto('/wp-admin/tools.php?page=graft-customizations');
	await row(page, 'flag-stale').getByRole('button', { name: 'Run now' }).click();
	await expect(message(page)).toContainText('Done: acted on 1 of');
	await expect(automation(page).locator('[data-graft-run="waiting-too-long/flag-stale"]').first()).toHaveAttribute('data-graft-run-status', 'ok');
	expect(await tagsOf(page)).toHaveLength(1);

	await login(page, 'editor');
	await page.goto('/wp-admin/index.php');
	const widget = page.locator('#graft-waiting-too-long');
	await expect(widget.locator('tbody tr', { hasText: 'Stuck in review' }).locator('[data-graft-field="days"]')).toHaveText('10');
});

test('publishing the post runs the event trigger from WP-Cron, which takes the tag off', async ({ page }) => {
	// WP-Cron holds a lock for up to a minute after a spawn that never reached it.
	test.setTimeout(180_000);
	await login(page, 'editor');
	// The editor's request only queues the trigger; WP-Cron runs it (requested here until it has).
	await api(page, { path: `/wp/v2/posts/${postId}`, method: 'POST', data: { status: 'publish' } });
	await login(page, 'admin');
	// What it found each time, so a failure shows whether the job ran and how.
	const state = async () => {
		await page.request.get('/wp-cron.php');
		const { runs } = await api<{ runs: Array<{ trigger: string; status: string; error?: string; calls?: Array<{ target: { title?: string }; ok: boolean; error?: string }> }> }>(page, { path: '/graft/v1/triggers' });
		return {
			tags: (await tagsOf(page)).length,
			runs: runs.filter((r) => r.trigger === 'clear-on-publish' && (r.error || r.calls?.some((c) => c.target.title === 'Stuck in review'))),
		};
	};
	await expect.poll(async () => (await state()).tags, { timeout: 150_000, intervals: [1_000, 2_000, 5_000] }).toBe(0).catch(async (error: Error) => {
		throw new Error(`${error.message}\nTrigger state: ${JSON.stringify(await state())}`);
	});

	await page.goto('/wp-admin/tools.php?page=graft-customizations');
	const run = automation(page).locator('[data-graft-run="waiting-too-long/clear-on-publish"]').first();
	await expect(run).toHaveAttribute('data-graft-run-status', 'ok');
	await expect(run).toContainText('event');
	await expect(run).toContainText('Stuck in review');
});

test('pausing all triggers stops every one, until they are resumed', async ({ page }) => {
	await login(page, 'admin');
	await page.goto('/wp-admin/tools.php?page=graft-customizations');
	await automation(page).getByRole('button', { name: 'Pause all' }).click();
	await expect(automation(page).locator('[data-graft-triggers-disabled]')).toHaveText('An administrator paused all triggers.');
	await expect(row(page, 'flag-stale').getByRole('button', { name: 'Run now' })).toBeDisabled();
	const refused = await api<{ status: string }>(page, { path: '/graft/v1/triggers/waiting-too-long/flag-stale/run', method: 'POST' });
	expect(refused.status).toBe('refused');
	await automation(page).getByRole('button', { name: 'Resume all' }).click();
	await expect(automation(page).locator('[data-graft-triggers-disabled]')).toHaveCount(0);
});

test('only administrators see or run triggers', async ({ page }) => {
	await login(page, 'editor');
	const status = await page.evaluate(async () => {
		try {
			await window.wp.apiFetch({ path: '/graft/v1/triggers/waiting-too-long/flag-stale/run', method: 'POST' });
			return 'allowed';
		} catch (error) {
			return (error as { code: string }).code;
		}
	});
	expect(status).toBe('rest_forbidden');
});
