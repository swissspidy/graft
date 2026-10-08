import { chromium, type Page } from '@playwright/test';

/**
 * Drives the A2UI review queue in wp-admin (run experiments/a2ui/server.ts
 * first): what an editor sees, approving a post through the gateway, and a
 * contributor's view without Approve. Screenshots go to test-results/.
 * CHROMIUM may point at a Chromium binary.
 */

const site = process.env.GRAFT_A2UI_SITE ?? 'http://127.0.0.1:9410';
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

const results: Array<[string, boolean, string?]> = [];
const check = (what: string, passed: boolean, detail?: string) => results.push([what, passed, detail]);

async function login(user: string) {
	await page.context().clearCookies();
	await page.goto(`${site}/wp-login.php`);
	await page.fill('#user_login', user);
	await page.fill('#user_pass', 'password');
	await page.click('#wp-submit');
	await page.waitForURL(/wp-admin/, { waitUntil: 'domcontentloaded' });
}

const table = (p: Page) => p.locator('#graft-a2ui table');
const rowTitles = (p: Page) => table(p).locator('tbody tr td:first-child strong').allTextContents();

try {
	await login('editor');
	await page.goto(`${site}/wp-admin/edit.php?page=graft-review-queue`);
	await page.locator('.graft-page table tbody tr').first().waitFor({ timeout: 30_000 });
	await page.screenshot({ path: 'test-results/a2ui-tree-version.png' });

	await page.goto(`${site}/wp-admin/edit.php?page=graft-a2ui`);
	await table(page).locator('tbody tr').first().waitFor({ timeout: 30_000 });
	await page.screenshot({ path: 'test-results/a2ui-editor.png' });
	check('heading and text from A2UI Text components', (await page.locator('#graft-a2ui').textContent())?.includes('Posts waiting for review, oldest first.') === true);
	const columns = await table(page).locator('thead th').allTextContents();
	check('columns', columns.join('|') === 'Title|Author|Submitted', columns.join(', '));
	const before = await rowTitles(page);
	check('pending posts listed', before.includes('Draft A') && before.includes('Draft E'), before.join(', '));
	check('editors get Approve', (await table(page).locator('[data-graft-action="approve"]').count()) === before.length);

	await table(page).locator('tbody tr', { hasText: 'Draft A' }).locator('[data-graft-action="approve"]').click();
	await page.locator('.components-notice', { hasText: 'Post published.' }).waitFor({ timeout: 30_000 });
	await table(page).locator('tbody tr', { hasText: 'Draft A' }).waitFor({ state: 'detached', timeout: 30_000 });
	await page.screenshot({ path: 'test-results/a2ui-after-approve.png' });
	check('Approve removes the row and shows the notice', !(await rowTitles(page)).includes('Draft A'));
	const status = await page.evaluate(async () => {
		const posts = (await (window as unknown as { wp: { apiFetch(o: { path: string }): Promise<Array<{ title: { raw: string }; status: string }>> } }).wp.apiFetch({ path: '/wp/v2/posts?search=Draft%20A&status=publish,pending&context=edit' })) as Array<{ title: { raw: string }; status: string }>;
		return posts.find((p) => p.title.raw === 'Draft A')?.status;
	});
	check('Draft A is published in WordPress', status === 'publish', String(status));

	await login('contributor');
	await page.goto(`${site}/wp-admin/edit.php?page=graft-a2ui`);
	await table(page).locator('tbody tr').first().waitFor({ timeout: 30_000 });
	await page.screenshot({ path: 'test-results/a2ui-contributor.png' });
	const theirs = await rowTitles(page);
	check('contributors see their pending posts', theirs.includes('Draft E'), theirs.join(', '));
	check('contributors get no Approve', (await table(page).locator('[data-graft-action="approve"]').count()) === 0);
} catch (error) {
	check('ran to the end', false, (error as Error).message.split('\n')[0]);
	await page.screenshot({ path: 'test-results/a2ui-failure.png' }).catch(() => {});
} finally {
	await browser.close();
}

check('no page errors', errors.length === 0, errors.join(' | '));
for (const [what, passed, detail] of results) {
	console.log(`${passed ? '✔' : '✘'} ${what}${detail && !passed ? `: ${detail}` : ''}`);
}
process.exit(results.every(([, passed]) => passed) ? 0 : 1);
