import { expect, test, type Page } from '@playwright/test';
import { login } from './login.ts';

/**
 * The example specs built as A2UI surfaces (examples/a2ui/builds) instead of
 * trees, served by the plugin through its own slots, gateway and grants,
 * drawn by build/a2ui.js. Same site and seed as runtime.spec.ts: Draft A
 * and Draft E pending (by the contributor), Draft B a draft, Post C
 * published, Old draft D a draft last updated forty days ago.
 * Tests run in order because they publish posts.
 */
test.describe.configure({ mode: 'serial' });

const listRow = (page: Page, title: string) => page.locator('#the-list tr', { hasText: title });
const queue = (page: Page) => page.locator('.graft-page table');
const queueRow = (page: Page, title: string) => queue(page).locator('tbody tr', { hasText: title });
const loaded = (page: Page, pattern: RegExp) => page.evaluate((source) => performance.getEntriesByType('resource').some((e) => new RegExp(source).test(e.name)), pattern.source);

test('Dashboard widgets need no code: headline verdicts and draft ages from catalog functions', async ({ page }) => {
	await login(page, 'editor');
	await page.goto('/wp-admin/index.php');
	const headlines = page.locator('#graft-headline-check');
	await expect(headlines.locator('tbody tr', { hasText: 'Draft A' }).locator('[data-graft-field="headline"]')).toHaveText('Too short');

	const drafts = page.locator('#graft-stale-drafts');
	const age = (title: string) => drafts.locator('tbody tr', { hasText: title }).locator('[data-graft-field="days"] [data-graft-tone]');
	await expect(age('Old draft D')).toHaveText('40');
	await expect(age('Old draft D')).toHaveAttribute('data-graft-tone', 'error');
	await expect(age('Draft B')).toHaveText('0');
	await expect(age('Draft B')).toHaveAttribute('data-graft-tone', 'success');
	await expect(drafts.locator('tbody tr', { hasText: 'Draft A' })).toHaveCount(0);

	// Drawn by the A2UI bundle; nothing ran in the functions sandbox.
	expect(await loaded(page, /build\/a2ui\.js/)).toBe(true);
	expect(await loaded(page, /functions-worker\.js|quickjs\.wasm/)).toBe(false);
	await page.screenshot({ path: 'test-results/a2ui-dashboard.png', fullPage: true });
});

test('pending by author: author buttons filter the list locally, and Everyone shows it all again', async ({ page }) => {
	await login(page, 'editor');
	await page.goto('/wp-admin/index.php');
	const widget = page.locator('#graft-pending-by-author');
	const titles = widget.locator('tbody tr [data-graft-field="title"]');
	// Newest first, as posts.list returns them.
	await expect(titles).toHaveText(['Draft E', 'Draft A']);
	// One button per author, drawn by a template, its action id computed from the name.
	const author = widget.locator('[data-graft-action="author-contributor user"]');
	await expect(author).toHaveText('Contributor User');
	await author.getByRole('button').click();
	await expect(widget.locator('tbody tr [data-graft-field="author/name"]')).toHaveText(['Contributor User', 'Contributor User']);
	await widget.getByRole('button', { name: 'Everyone' }).click();
	await expect(titles).toHaveText(['Draft E', 'Draft A']);
});

test('quick approve: an A2UI button in the Posts list row actions, on pending posts only', async ({ page }) => {
	await login(page, 'editor');
	await page.goto('/wp-admin/edit.php');
	await expect(listRow(page, 'Draft A').locator('[data-graft-action="approve"]')).toHaveCount(1);
	await expect(listRow(page, 'Draft B').locator('[data-graft-action="approve"]')).toHaveCount(0);
	await expect(listRow(page, 'Post C').locator('[data-graft-action="approve"]')).toHaveCount(0);
	await page.screenshot({ path: 'test-results/a2ui-row-actions.png' });

	const draftE = listRow(page, 'Draft E');
	await draftE.hover();
	await Promise.all([page.waitForEvent('load'), draftE.locator('[data-graft-action="approve"]').getByRole('button').click()]);
	await expect(listRow(page, 'Draft E')).not.toContainText('Pending');
	await expect(listRow(page, 'Draft E').locator('[data-graft-action="approve"]')).toHaveCount(0);
});

test('contributors see the review queue without Approve, and the gateway refuses them anyway', async ({ page }) => {
	await login(page, 'contributor');
	await page.goto('/wp-admin/admin.php?page=graft-review-queue');
	await expect(queue(page).locator('tbody tr').first()).toBeVisible();
	await expect(queue(page).locator('[data-graft-action="approve"]')).toHaveCount(0);
	const refused = await page.evaluate(async () => {
		try {
			await (window as unknown as { wp: { apiFetch(o: object): Promise<unknown> } }).wp.apiFetch({
				path: '/graft/v1/call',
				method: 'POST',
				data: { spec: 'review-queue', capability: 'posts.update_status', input: { id: 1, status: 'publish' } },
			});
			return 'allowed';
		} catch (error) {
			return (error as { code: string }).code;
		}
	});
	expect(refused).not.toBe('allowed');
});

test('editors approve from the review queue: the event runs its capability and drops the row', async ({ page }) => {
	await login(page, 'editor');
	await page.goto('/wp-admin/admin.php?page=graft-review-queue');
	await expect(queue(page).locator('thead th')).toHaveText(['Title', 'Author', 'Submitted', 'Actions']);
	await expect(queueRow(page, 'Draft A')).toContainText('Contributor User');
	await page.screenshot({ path: 'test-results/a2ui-review-queue.png' });
	await queueRow(page, 'Draft A').getByRole('button', { name: 'Approve' }).click();
	await expect(page.locator('.components-notice__content', { hasText: /published/i })).toBeVisible();
	await expect(queueRow(page, 'Draft A')).toHaveCount(0);
	await page.goto('/wp-admin/edit.php?post_status=publish&post_type=post');
	await expect(page.locator('#the-list')).toContainText('Draft A');
});

test('admins approve an A2UI customization in plain language, and it appears', async ({ page }) => {
	await login(page, 'admin');
	await page.goto('/wp-admin/index.php');
	await expect(page.locator('#graft-waiting-posts')).toHaveCount(0);
	await page.goto('/wp-admin/tools.php?page=graft-customizations');
	const card = page.locator('[data-graft-spec="waiting-posts"]');
	// Described like any customization: what it may do, and what its checks prove.
	await expect(card.locator('[data-graft-state]')).toHaveText('Needs approval');
	await expect(card).toContainText('verified');
	await expect(card.locator('.graft-permissions')).toContainText('See posts you can edit, including drafts and pending posts (not granted yet)');
	await expect(card.locator('.graft-checks')).toContainText('Shows at most five posts');
	await card.getByRole('button', { name: 'Approve' }).click();
	await expect(card.locator('[data-graft-state]')).toHaveText('Active');
	await page.goto('/wp-admin/index.php');
	await expect(page.locator('#graft-waiting-posts')).toContainText('Nothing is waiting');
});

test('the publish checklist in the block editor: no code, follows typing, saves, publishes', async ({ page }) => {
	await login(page, 'editor');
	const guide = page.getByRole('dialog', { name: /welcome/i });
	await page.addLocatorHandler(guide, () => guide.getByRole('button', { name: /close/i }).click());
	await page.goto('/wp-admin/edit.php');
	await page.locator('#the-list').getByRole('link', { name: 'Draft B', exact: true }).first().click();
	const panel = page.locator('.graft-editor-panel');
	const toggle = page.getByRole('button', { name: 'Publish checklist' });
	await toggle.waitFor({ timeout: 60_000 });
	if (!(await panel.isVisible())) {
		await toggle.click();
	}

	await expect(panel.getByLabel('Headline')).toHaveValue('Draft B', { timeout: 30_000 });
	await expect(panel.getByText('✗ Headline is 20 to 70 characters (7 now)')).toBeVisible();
	await expect(panel.getByText('✗ Excerpt of at least 50 characters (0 now)')).toBeVisible();

	await panel.getByLabel('Headline').fill('Draft B gets a headline that fits');
	await expect(panel.getByText('✓ Headline is 20 to 70 characters')).toBeVisible();
	await panel.getByLabel('Excerpt').fill('A short summary of the post, for search results and social media.');
	await panel.getByLabel('Facts and names checked').check();
	await expect(panel.getByText('✓ Facts and names checked')).toBeVisible();
	// A2UI checks: Publish stays, disabled, until the changes are saved.
	await expect(panel.getByRole('button', { name: 'Publish' })).toBeDisabled();
	await page.screenshot({ path: 'test-results/a2ui-publish-checklist.png' });

	// While the editor has unsaved changes of its own, nothing is written (the gateway's guard).
	await page.evaluate(() => (window as unknown as EditorData).wp.data.dispatch('core/editor').editPost({ title: 'Draft B, edited in the editor' }));
	await panel.getByRole('button', { name: 'Save' }).click();
	await expect(panel.getByText('Save or discard your changes to the post first.')).toBeVisible();
	await page.evaluate(() => (window as unknown as EditorData).wp.data.dispatch('core/editor').editPost({ title: 'Draft B' }));
	await expect.poll(() => page.evaluate(() => (window as unknown as EditorData).wp.data.select('core/editor').isEditedPostDirty())).toBe(false);

	const saved = page.waitForEvent('load', { timeout: 60_000 });
	await panel.getByRole('button', { name: 'Save' }).click();
	await saved;
	await expect(panel.getByLabel('Headline')).toHaveValue('Draft B gets a headline that fits', { timeout: 60_000 });

	await panel.getByLabel('Facts and names checked').check();
	const publish = panel.getByRole('button', { name: 'Publish' });
	await expect(publish).toBeEnabled();
	const published = page.waitForEvent('load', { timeout: 60_000 });
	await publish.click();
	await published;
	await page.goto('/wp-admin/edit.php?post_status=publish&post_type=post');
	await expect(page.locator('#the-list')).toContainText('Draft B gets a headline that fits');
	expect(await loaded(page, /functions-worker\.js|quickjs\.wasm/)).toBe(false);
});

interface EditorData {
	wp: {
		data: {
			dispatch(store: 'core/editor'): { editPost(edits: Record<string, unknown>): void };
			select(store: 'core/editor'): { isEditedPostDirty(): boolean };
		};
	};
}
