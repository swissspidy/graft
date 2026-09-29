import { expect, test, type Page } from '@playwright/test';

/**
 * Milestone 3: the plugin serves hand-written builds of the example specs
 * in real wp-admin, and the gateway enforces grants.
 *
 * The site is seeded by playground/seed-e2e.php with Draft A and Draft E
 * (pending, by the contributor), Draft B (draft) and Post C (published).
 * Tests run in order because they publish posts.
 */
test.describe.configure({ mode: 'serial' });

async function login(page: Page, user: string) {
	await page.goto('/wp-login.php');
	await page.fill('#user_login', user);
	await page.fill('#user_pass', 'password');
	await page.click('#wp-submit');
	await page.waitForURL(/wp-admin/);
}

const queue = (page: Page) => page.locator('.graft-page table');
const queueRow = (page: Page, title: string) => queue(page).locator('tbody tr', { hasText: title });
const listRow = (page: Page, title: string) => page.locator('#the-list tr', { hasText: title });

test('contributors see their pending posts in the review queue, without Approve', async ({ page }) => {
	await login(page, 'contributor');
	await page.goto('/wp-admin/admin.php?page=graft-review-queue');
	await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible();
	await expect(queueRow(page, 'Draft A')).toBeVisible();
	await expect(queueRow(page, 'Draft E')).toBeVisible();
	await expect(queue(page).locator('[data-graft-action="approve"]')).toHaveCount(0);
});

test('the gateway refuses what a contributor may not do, even when called directly', async ({ page }) => {
	await login(page, 'contributor');
	await page.goto('/wp-admin/admin.php?page=graft-review-queue');
	await expect(queueRow(page, 'Draft A')).toBeVisible();
	const call = (capability: string, input: unknown) =>
		page.evaluate(
			async ({ capability, input }) => {
				try {
					return await window.wp.apiFetch({ path: '/graft/v1/call', method: 'POST', data: { spec: 'review-queue', capability, input } });
				} catch (error) {
					return { error: (error as { code: string }).code };
				}
			},
			{ capability, input },
		);
	const list = (await call('posts.list', { status: ['pending'] })) as { items: Array<{ id: number; title: string }> };
	const draftA = list.items.find((item) => item.title === 'Draft A')!;
	expect(await call('posts.update_status', { id: draftA.id, status: 'publish' })).toEqual({ error: 'ability_invalid_permissions' });
	expect(await call('site.info', null)).toEqual({ error: 'graft_capability_not_in_build' });
	expect(
		await page.evaluate(async () => {
			try {
				await window.wp.apiFetch({ path: '/graft/v1/call', method: 'POST', data: { spec: 'quick-approve', capability: 'posts.update_status', input: {} } });
				return 'allowed';
			} catch (error) {
				return (error as { code: string }).code;
			}
		}),
	).toBe('graft_spec_unavailable');
});

test('quick approve appears on pending posts only and publishes from the Posts screen', async ({ page }) => {
	await login(page, 'editor');
	await page.goto('/wp-admin/edit.php');
	await expect(listRow(page, 'Draft A').locator('[data-graft-action="approve"]')).toHaveCount(1);
	await expect(listRow(page, 'Draft B').locator('[data-graft-action="approve"]')).toHaveCount(0);
	await expect(listRow(page, 'Post C').locator('[data-graft-action="approve"]')).toHaveCount(0);

	const draftE = listRow(page, 'Draft E');
	await expect(draftE).toContainText('Pending');
	await draftE.hover();
	await Promise.all([page.waitForEvent('load'), draftE.locator('[data-graft-action="approve"]').click()]);
	await expect(listRow(page, 'Draft E')).not.toContainText('Pending');
	await expect(listRow(page, 'Draft E').locator('[data-graft-action="approve"]')).toHaveCount(0);
});

test('editors see only pending posts with the right columns, and approve them', async ({ page }) => {
	await login(page, 'editor');
	await page.goto('/wp-admin/edit.php');
	await page.locator('#adminmenu').getByRole('link', { name: 'Review queue' }).click();
	await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible();
	await expect(queue(page).locator('thead th')).toHaveText(['Title', 'Author', 'Submitted', 'Actions']);
	await expect(queue(page).locator('tbody tr')).toHaveCount(1);
	await expect(queueRow(page, 'Draft A')).toContainText('Contributor User');
	await page.screenshot({ path: 'test-results/review-queue.png', fullPage: false });

	await queueRow(page, 'Draft A').getByRole('button', { name: 'Approve' }).click();
	await expect(page.locator('.components-notice__content', { hasText: 'Post published.' })).toBeVisible();
	await expect(queue(page).locator('[data-graft-empty]')).toHaveText('Nothing to review');

	await page.goto('/wp-admin/edit.php?post_status=publish&post_type=post');
	await expect(page.locator('#the-list')).toContainText('Draft A');
});

test('the served specs are verified, not flagged', async ({ page }) => {
	await login(page, 'admin');
	const specs = (await page.evaluate(() => window.wp.apiFetch({ path: '/graft/v1/specs' }))) as Array<{
		spec_id: string;
		versions: Array<{ state: string; unverified: boolean; builds: Record<string, { verification: { passed: boolean } | null }> }>;
	}>;
	expect(specs.map((s) => s.spec_id).sort()).toEqual(['quick-approve', 'review-queue']);
	for (const spec of specs) {
		const version = spec.versions[0]!;
		expect(version.state).toBe('active');
		expect(version.unverified).toBe(false);
		expect(Object.values(version.builds)[0]!.verification?.passed).toBe(true);
	}
});

test('subscribers get no review queue', async ({ page }) => {
	await login(page, 'subscriber');
	const response = await page.goto('/wp-admin/admin.php?page=graft-review-queue');
	expect(response?.status()).toBe(403);
});

declare global {
	interface Window {
		wp: { apiFetch(options: { path: string; method?: string; data?: unknown }): Promise<unknown> };
	}
}
