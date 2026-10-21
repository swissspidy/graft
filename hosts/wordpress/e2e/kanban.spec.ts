import { expect, test, type Locator, type Page } from '@playwright/test';
import { login } from './login.ts';

/**
 * The editorial board (examples/specs/kanban-board.md), served from its
 * Board build: a card moves by its buttons (the keyboard way) and by
 * dragging, each move goes through the gateway as the viewer, and what a
 * contributor may not do is neither offered nor let through.
 *
 * The test writes its own post ("Board story") and deletes it at the end,
 * so the seeded posts other tests count stay as they are.
 */
test.describe.configure({ mode: 'serial' });

const story = 'Board story';
const column = (page: Page, id: string) => page.locator(`[data-graft-column="${id}"]`);
const card = (scope: Page | Locator, title: string) => scope.locator(`[data-graft-card="${title}"]`);

/** The REST API, as the logged-in user. */
const rest = (page: Page, path: string, method = 'GET', data?: unknown) =>
	page.evaluate(
		async ({ path, method, data }) => {
			try {
				return await window.wp.apiFetch({ path, method, data });
			} catch (error) {
				return { error: (error as { code: string }).code };
			}
		},
		{ path, method, data },
	);

const statusOf = async (page: Page, id: number) => ((await rest(page, `/wp/v2/posts/${id}?context=edit`)) as { status: string }).status;

let id = 0;

test.afterAll(async ({ browser }) => {
	if (!id) {
		return;
	}
	const page = await browser.newPage();
	await login(page, 'editor');
	await page.goto('/wp-admin/');
	await rest(page, `/wp/v2/posts/${id}?force=true`, 'DELETE');
	await page.close();
});

test('contributors move their own cards between Draft and Pending review, and no further', async ({ page }) => {
	await login(page, 'contributor');
	await page.goto('/wp-admin/');
	id = ((await rest(page, '/wp/v2/posts', 'POST', { title: story, status: 'draft' })) as { id: number }).id;
	expect(id).toBeGreaterThan(0);

	await page.goto('/wp-admin/edit.php');
	await page.locator('#adminmenu').getByRole('link', { name: 'Board', exact: true }).click();
	await expect(page.getByRole('heading', { name: /^Draft/ })).toBeVisible();
	await expect(page.getByRole('heading', { name: /^Pending review/ })).toBeVisible();
	await expect(page.getByRole('heading', { name: /^Published/ })).toBeVisible();

	// Only the posts a contributor can edit: their own, never Post C (the editor's, published).
	await expect(card(column(page, 'draft'), story)).toBeVisible();
	await expect(card(column(page, 'pending'), 'Draft A')).toBeVisible();
	await expect(card(page, 'Post C')).toHaveCount(0);
	await expect(column(page, 'publish')).toContainText('Nothing published yet.');
	// Cards show the author and how long ago they changed.
	await expect(card(page, story)).toContainText('Contributor User');
	await expect(card(page, story)).toContainText('today');

	// Nothing on the board moves a card into or out of Published for a contributor.
	await expect(column(page, 'pending').locator('[data-graft-action="publish"]')).toHaveCount(0);
	await expect(card(page, 'Draft A').locator('[data-graft-action="to-draft"]')).toHaveCount(1);
	await page.screenshot({ path: 'test-results/kanban-contributor.png', fullPage: true });

	// The keyboard way: the card's own button, with Enter.
	await card(page, story).getByRole('button', { name: `Pending review →: ${story}` }).focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('.components-notice__content', { hasText: 'Sent for review.' })).toBeVisible();
	await expect(card(column(page, 'pending'), story)).toBeVisible();
	expect(await statusOf(page, id)).toBe('pending');

	// Dropping it on Published does nothing: the column does not take it.
	await card(page, story).dragTo(column(page, 'publish'));
	await expect(card(column(page, 'pending'), story)).toBeVisible();
	expect(await statusOf(page, id)).toBe('pending');
});

test('the gateway refuses a contributor the moves the board does not offer them, even when called directly', async ({ page }) => {
	await login(page, 'contributor');
	await page.goto('/wp-admin/admin.php?page=graft-kanban-board');
	await expect(card(page, story)).toBeVisible();
	const call = (capability: string, input: unknown) => rest(page, '/graft/v1/call', 'POST', { spec: 'kanban-board', capability, input });

	expect(await call('posts.update_status', { id, status: 'publish' })).toEqual({ error: 'ability_invalid_permissions' });
	// The narrow capability never publishes: its input only takes draft and pending.
	expect(await call('posts.update_review_status', { id, status: 'publish' })).toEqual({ error: 'ability_invalid_input' });
	// Published posts are not theirs to edit, so none reach them to move.
	const published = (await rest(page, '/graft/v1/call', 'POST', { spec: 'kanban-board', capability: 'posts.list', input: { status: ['publish'] } })) as { items: unknown[] };
	expect(published.items).toEqual([]);
	expect(await statusOf(page, id)).toBe('pending');
});

test('editors drag a card to Published, and move it back with its button', async ({ page }) => {
	await login(page, 'editor');
	await page.goto('/wp-admin/admin.php?page=graft-kanban-board');
	await expect(card(column(page, 'pending'), story)).toBeVisible();
	await expect(card(column(page, 'publish'), 'Post C')).toBeVisible();
	await expect(card(page, story).locator('[data-graft-action="publish"]')).toHaveCount(1);
	await page.screenshot({ path: 'test-results/kanban-editor.png', fullPage: true });

	await card(page, story).dragTo(column(page, 'publish'));
	await expect(page.locator('.components-notice__content', { hasText: 'Published.' })).toBeVisible();
	await expect(card(column(page, 'publish'), story)).toBeVisible();
	expect(await statusOf(page, id)).toBe('publish');

	// A published post goes back to review, not straight to Draft.
	await expect(card(page, story).locator('[data-graft-action="to-draft"]')).toHaveCount(0);
	await card(page, story).getByRole('button', { name: `← Pending review: ${story}` }).click();
	await expect(card(column(page, 'pending'), story)).toBeVisible();
	expect(await statusOf(page, id)).toBe('pending');

	// The narrow capability refuses to unpublish, even for an editor.
	expect(await rest(page, '/graft/v1/call', 'POST', { spec: 'kanban-board', capability: 'posts.update_status', input: { id, status: 'publish' } })).toMatchObject({ status: 'publish' });
	expect(await rest(page, '/graft/v1/call', 'POST', { spec: 'kanban-board', capability: 'posts.update_review_status', input: { id, status: 'draft' } })).toEqual({ error: 'ability_invalid_permissions' });
	expect(await statusOf(page, id)).toBe('publish');
});
