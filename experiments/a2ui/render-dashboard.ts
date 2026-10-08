import { chromium } from '@playwright/test';

/**
 * Drives the compiled A2UI Dashboard widgets (run experiments/a2ui/server.ts
 * first): pending-by-author's local state (author buttons filter the rows,
 * Everyone shows them all, Approve publishes through the gateway), and that
 * the code-free headline check and stale drafts draw, and waiting-posts,
 * which the site has not approved, does not.
 * Screenshots go to test-results/. CHROMIUM may point at a Chromium binary.
 */

const site = process.env.GRAFT_A2UI_SITE ?? 'http://127.0.0.1:9410';
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 1400 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));

const results: Array<[string, boolean, string?]> = [];
const check = (what: string, passed: boolean, detail?: string) => results.push([what, passed, detail]);

try {
	await page.goto(`${site}/wp-login.php`);
	await page.fill('#user_login', 'editor');
	await page.fill('#user_pass', 'password');
	await page.click('#wp-submit');
	await page.waitForURL(/wp-admin/, { waitUntil: 'domcontentloaded' });
	await page.goto(`${site}/wp-admin/index.php`);

	const widget = page.locator('#graft-a2ui-pending-by-author');
	const rows = widget.locator('[data-graft-row]');
	await rows.first().waitFor({ timeout: 30_000 });
	const titles = () => widget.locator('[data-graft-row] [data-graft-field="title"]').allTextContents();
	const authors = () => widget.locator('[data-graft-row] [data-graft-field="author/name"]').allTextContents();
	const all = await titles();
	const everyAuthor = [...new Set(await authors())];
	check('pending posts listed with authors', all.length > 0 && everyAuthor.length > 0, `${all.join(', ')} / ${everyAuthor.join(', ')}`);
	await page.screenshot({ path: 'test-results/a2ui-dashboard.png', fullPage: true });

	// The author buttons are drawn from the data by an A2UI template.
	const chosen = everyAuthor[0]!;
	await widget.getByRole('button', { name: chosen, exact: true }).click();
	await page.waitForFunction(
		([name]) => [...document.querySelectorAll('#graft-a2ui-pending-by-author [data-graft-row] [data-graft-field="author/name"]')].every((cell) => cell.textContent === name),
		[chosen],
		{ timeout: 10_000 },
	);
	const filtered = await authors();
	check(`choosing ${chosen} lists only their posts`, filtered.length > 0 && filtered.every((name) => name === chosen), filtered.join(', '));
	await page.screenshot({ path: 'test-results/a2ui-dashboard-filtered.png', fullPage: true });

	await widget.getByRole('button', { name: 'Everyone', exact: true }).click();
	await page.waitForFunction((count) => document.querySelectorAll('#graft-a2ui-pending-by-author [data-graft-row]').length === count, all.length, { timeout: 10_000 });
	check('Everyone lists every pending post again', (await titles()).length === all.length);

	const first = all[0]!;
	await widget.locator('[data-graft-row]', { hasText: first }).locator('[data-graft-action="approve"]').click();
	await widget.locator('[data-graft-row]', { hasText: first }).waitFor({ state: 'detached', timeout: 30_000 });
	check('Approve publishes and the post leaves the list', !(await titles()).includes(first));

	for (const [spec, what] of [
		['headline-check', 'Headline'],
		['stale-drafts', ''],
	] as const) {
		const box = page.locator(`#graft-a2ui-${spec}`);
		await box.locator('table, p, div').first().waitFor({ timeout: 30_000 }).catch(() => {});
		const text = (await box.textContent()) ?? '';
		check(`${spec} draws`, text.trim().length > 0 && text.includes(what), text.slice(0, 120));
	}
	// The e2e site leaves waiting-posts unapproved: no grant, so nothing is drawn.
	check('waiting-posts, not approved, is not drawn', (await page.locator('#graft-a2ui-waiting-posts').count()) === 0);
	const verdicts = await page.locator('#graft-a2ui-headline-check [data-graft-row] [data-graft-field="headline"]').allTextContents();
	check('headline-check gives every pending post a verdict', verdicts.length > 0 && verdicts.every((v) => /Looks good|Too long|All caps|Too short/.test(v)), verdicts.join(' | '));
	await page.screenshot({ path: 'test-results/a2ui-dashboard-after.png', fullPage: true });
} catch (error) {
	check('ran to the end', false, (error as Error).message.split('\n')[0]);
	await page.screenshot({ path: 'test-results/a2ui-dashboard-failure.png', fullPage: true }).catch(() => {});
} finally {
	await browser.close();
}

check('no page errors', errors.length === 0, errors.join(' | '));
for (const [what, passed, detail] of results) {
	console.log(`${passed ? '✔' : '✘'} ${what}${detail ? `: ${detail}` : ''}`);
}
process.exit(results.every(([, passed]) => passed) ? 0 : 1);
