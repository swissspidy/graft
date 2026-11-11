import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { login } from './login.ts';

/**
 * Customizations people write for themselves (ADR 0014): a contributor has
 * the screen under Tools, with their own customizations and nothing of the
 * site's, and builds one that goes live without an administrator.
 */

/** Whether wp-admin verifies builds in Playground in the browser (CI only). */
const browserVerify = process.env.GRAFT_E2E_BROWSER_VERIFY === '1';

const source = readFileSync(new URL('../../../examples/specs/waiting-posts.md', import.meta.url), 'utf8')
	.replace('id: waiting-posts', 'id: my-waiting')
	.replace('# Waiting for review', '# My waiting posts');

test('people who are not administrators have their own customizations under Tools, and none of the site\'s', async ({ page }) => {
	await login(page, 'contributor');
	await page.goto('/wp-admin/tools.php?page=graft-customizations');
	await expect(page.locator('[data-graft-mine]')).toContainText('Customizations you wrote for yourself');
	await expect(page.getByText('You have not written any yet.')).toBeVisible();
	// The site's customizations, its automation and its history are the administrators'.
	await expect(page.locator('[data-graft-spec]')).toHaveCount(0);
	await expect(page.locator('[data-graft-history]')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Pause all' })).toHaveCount(0);

	await page.getByRole('button', { name: 'New customization' }).click();
	await expect(page.locator('[data-graft-personal-only]')).toContainText('yours alone');
	await expect(page.locator('[data-graft-personal-only]')).toContainText('posts:read');
	await expect(page.getByRole('checkbox', { name: 'Only for me' })).toBeHidden();
});

test('the site\'s customizations stay out of their reach over REST', async ({ page }) => {
	await login(page, 'contributor');
	await page.goto('/wp-admin/tools.php?page=graft-customizations');
	const statuses = await page.evaluate(async () => {
		const call = (path: string, method = 'GET') =>
			(window as unknown as { wp: { apiFetch(o: object): Promise<unknown> } }).wp
				.apiFetch({ path, method, parse: false })
				.then(
					(r) => (r as Response).status,
					(r) => (r as Response).status,
				);
		return [await call('/graft/v1/changes'), await call('/graft/v1/audit'), await call('/graft/v1/specs/review-queue/versions/1/archive', 'POST'), await call('/graft/v1/specs/review-queue/versions/1/approve', 'POST')];
	});
	expect(statuses).toEqual([403, 403, 403, 403]);
});

test('a contributor builds a customization that only reads, and it is live for them alone', async ({ page, browser }) => {
	test.skip(!browserVerify, 'A customization of one\'s own is only saved once its checks pass, which needs Playground in the browser (CI).');
	test.setTimeout(240_000);
	await login(page, 'contributor');
	await page.goto('/wp-admin/tools.php?page=graft-customizations');
	await page.getByRole('button', { name: 'New customization' }).click();
	await page.locator('#graft-spec-source').fill(source);
	await expect(page.locator('.graft-diagnostics')).toContainText('Valid for this site.');
	await page.getByRole('button', { name: 'Build it' }).click();
	await expect(page.locator('.components-notice__content', { hasText: 'is live for you' })).toBeVisible({ timeout: 180_000 });
	const card = page.locator('[data-graft-spec="my-waiting"]');
	await expect(card.locator('[data-graft-state]')).toHaveText('Active');

	// On their Dashboard, though the spec's audience names editors; not on an editor's.
	await page.goto('/wp-admin/index.php');
	await expect(page.locator('#graft-my-waiting')).toContainText('My waiting posts');
	const other = await browser.newPage();
	await login(other, 'editor');
	await other.goto('/wp-admin/index.php');
	await expect(other.locator('#graft-waiting-posts')).toBeVisible();
	await expect(other.locator('#graft-my-waiting')).toHaveCount(0);
	await other.close();

	// And they can take it down again.
	await page.goto('/wp-admin/tools.php?page=graft-customizations');
	await card.getByRole('button', { name: 'Archive' }).click();
	await expect(card.locator('[data-graft-state]')).toHaveText('Archived');
});
