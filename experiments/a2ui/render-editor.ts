import { chromium } from '@playwright/test';

/**
 * Drives the compiled A2UI publish checklist in the block editor (run
 * experiments/a2ui/server.ts first), the way hosts/wordpress/e2e checks the
 * tree version: prefilled fields, a checklist that follows typing, Save,
 * then Publish once everything is ticked and saved. Screenshots go to
 * test-results/. CHROMIUM may point at a Chromium binary.
 */

const site = process.env.GRAFT_A2UI_SITE ?? 'http://127.0.0.1:9410';
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));

const results: Array<[string, boolean, string?]> = [];
const check = (what: string, passed: boolean, detail?: string) => results.push([what, passed, detail]);
const panel = page.locator('#graft-a2ui');
const visible = (text: string) => panel.getByText(text, { exact: true }).first().isVisible();

try {
	await page.goto(`${site}/wp-login.php`);
	await page.fill('#user_login', 'editor');
	await page.fill('#user_pass', 'password');
	await page.click('#wp-submit');
	await page.waitForURL(/wp-admin/, { waitUntil: 'domcontentloaded' });
	const guide = page.getByRole('dialog', { name: /welcome/i });
	await page.addLocatorHandler(guide, () => guide.getByRole('button', { name: /close/i }).click());

	await page.goto(`${site}/wp-admin/edit.php`);
	await page.locator('#the-list').getByRole('link', { name: 'Draft B', exact: true }).first().click();
	const toggle = page.getByRole('button', { name: 'Publish checklist (A2UI)', exact: true });
	await toggle.waitFor({ timeout: 60_000 });
	if (!(await panel.isVisible())) {
		await toggle.click();
	}
	const headline = panel.getByLabel('Headline');
	await headline.waitFor({ timeout: 30_000 });
	check('headline prefilled', (await headline.inputValue()) === 'Draft B', await headline.inputValue());
	check('checklist from the saved post', (await visible('✗ Headline is 20 to 70 characters (7 now)')) && (await visible('✗ Excerpt of at least 50 characters (0 now)')));
	await page.screenshot({ path: 'test-results/a2ui-checklist-initial.png' });

	await headline.fill('Draft B gets a headline that fits');
	check('follows typing', await visible('✓ Headline is 20 to 70 characters'));
	await panel.getByLabel('Excerpt').fill('A short summary of the post, for search results and social media.');
	await panel.getByLabel('Facts and names checked').check();
	check('facts ticked', await visible('✓ Facts and names checked'));
	check('asks to save first', await visible('Save your changes before publishing.'));
	check('Publish disabled while unsaved', await panel.getByRole('button', { name: 'Publish' }).isDisabled());
	await page.screenshot({ path: 'test-results/a2ui-checklist-typed.png' });

	// While the editor has unsaved changes of its own, nothing is written.
	type EditorData = { data: { dispatch(store: string): { editPost(edits: object): void }; select(store: string): { isEditedPostDirty(): boolean } } };
	await page.evaluate(() => (window.wp as unknown as EditorData).data.dispatch('core/editor').editPost({ title: 'Draft B, edited in the editor' }));
	await panel.getByRole('button', { name: 'Save' }).click();
	check('refuses while the editor has unsaved changes', await panel.getByText('Save or discard your changes to the post first.').waitFor({ timeout: 10_000 }).then(() => true, () => false));
	await page.evaluate(() => (window.wp as unknown as EditorData).data.dispatch('core/editor').editPost({ title: 'Draft B' }));
	await page.waitForFunction(() => !(window.wp as unknown as EditorData).data.select('core/editor').isEditedPostDirty());

	const saved = page.waitForEvent('load', { timeout: 60_000 });
	await panel.getByRole('button', { name: 'Save' }).click();
	await saved;
	await headline.waitFor({ timeout: 60_000 });
	await page.waitForFunction(() => (document.querySelector('#graft-a2ui input') as HTMLInputElement | null)?.value === 'Draft B gets a headline that fits', undefined, { timeout: 60_000 });
	check('saved and reloaded', (await headline.inputValue()) === 'Draft B gets a headline that fits');

	await panel.getByLabel('Facts and names checked').check();
	const publish = panel.getByRole('button', { name: 'Publish' });
	check('Publish enabled once ticked and saved', await publish.isEnabled());
	await page.screenshot({ path: 'test-results/a2ui-checklist-ready.png' });
	const published = page.waitForEvent('load', { timeout: 60_000 });
	await publish.click();
	await published;
	const status = await page.evaluate(async () => {
		const posts = (await (window as unknown as { wp: { apiFetch(o: { path: string }): Promise<unknown> } }).wp.apiFetch({ path: '/wp/v2/posts?search=Draft%20B&status=publish,draft&context=edit' })) as Array<{ title: { raw: string }; status: string }>;
		return posts.find((p) => p.title.raw === 'Draft B gets a headline that fits')?.status;
	});
	check('published in WordPress', status === 'publish', String(status));
} catch (error) {
	check('ran to the end', false, (error as Error).message.split('\n')[0]);
	await page.screenshot({ path: 'test-results/a2ui-checklist-failure.png' }).catch(() => {});
} finally {
	await browser.close();
}

check('no page errors', errors.length === 0, errors.join(' | '));
for (const [what, passed, detail] of results) {
	console.log(`${passed ? '✔' : '✘'} ${what}${detail && !passed ? `: ${detail}` : ''}`);
}
process.exit(results.every(([, passed]) => passed) ? 0 : 1);
