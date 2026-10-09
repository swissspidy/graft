import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { login } from './login.ts';

/**
 * The plugin serves the example specs' builds (A2UI surfaces, drawn by
 * build/a2ui.js) in real wp-admin, and the gateway enforces grants.
 *
 * The site is seeded by playground/seed-e2e.php with Draft A and Draft E
 * (pending, by the contributor), Draft B (draft), Post C (published) and
 * Old draft D (a draft last updated forty days ago).
 * Tests run in order because they publish posts.
 */
test.describe.configure({ mode: 'serial' });

const queue = (page: Page) => page.locator('.graft-page table');
const queueRow = (page: Page, title: string) => queue(page).locator('tbody tr', { hasText: title });
const listRow = (page: Page, title: string) => page.locator('#the-list tr', { hasText: title });

/** Whether this document fetched a resource matching `pattern`. */
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

	// Drawn by the A2UI bundle.
	expect(await loaded(page, /build\/a2ui\.js/)).toBe(true);
	await page.screenshot({ path: 'test-results/dashboard.png', fullPage: true });
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

test('quick approve: a button in the Posts list row actions, on pending posts only', async ({ page }) => {
	await login(page, 'editor');
	await page.goto('/wp-admin/edit.php');
	await expect(listRow(page, 'Draft A').locator('[data-graft-action="approve"]')).toHaveCount(1);
	await expect(listRow(page, 'Draft B').locator('[data-graft-action="approve"]')).toHaveCount(0);
	await expect(listRow(page, 'Post C').locator('[data-graft-action="approve"]')).toHaveCount(0);
	await page.screenshot({ path: 'test-results/row-actions.png' });

	const draftE = listRow(page, 'Draft E');
	await draftE.hover();
	await Promise.all([page.waitForEvent('load'), draftE.locator('[data-graft-action="approve"]').getByRole('button').click()]);
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
	await expect(page.locator('.components-notice__content', { hasText: 'Post approved and published.' })).toBeVisible();
	await expect(queue(page).locator('[data-graft-empty]')).toHaveText('Nothing to review');

	await page.goto('/wp-admin/edit.php?post_status=publish&post_type=post');
	await expect(page.locator('#the-list')).toContainText('Draft A');
});

test('the gateway logs what it refused, for administrators only', async ({ page }) => {
	await login(page, 'admin');
	const log = (await page.evaluate(() => window.wp.apiFetch({ path: '/graft/v1/audit' }))) as Array<{ spec: string; capability: string; code: string; user: number }>;
	// From the contributor's direct calls earlier.
	expect(log).toContainEqual(expect.objectContaining({ spec: 'review-queue', capability: 'site.info', code: 'graft_capability_not_in_build' }));
	expect(log).toContainEqual(expect.objectContaining({ spec: 'quick-approve', capability: 'posts.update_status', code: 'graft_spec_unavailable' }));

	await login(page, 'editor');
	const status = await page.evaluate(async () => {
		try {
			await window.wp.apiFetch({ path: '/graft/v1/audit' });
			return 'allowed';
		} catch (error) {
			return (error as { code: string }).code;
		}
	});
	expect(status).toBe('rest_forbidden');
});

test('the served specs are verified, not flagged', async ({ page }) => {
	await login(page, 'admin');
	const specs = (await page.evaluate(() => window.wp.apiFetch({ path: '/graft/v1/specs' }))) as Array<{
		spec_id: string;
		versions: Array<{ state: string; unverified: boolean; builds: Record<string, { verification: { passed: boolean } | null }> }>;
	}>;
	expect(specs.filter((s) => s.spec_id !== 'waiting-copy').map((s) => [s.spec_id, s.versions[0]!.state]).sort()).toEqual([
		['headline-check', 'active'],
		['pending-by-author', 'active'],
		['publish-checklist', 'active'],
		['quick-approve', 'active'],
		['review-queue', 'active'],
		['stale-drafts', 'active'],
		['waiting-posts', 'needs_approval'],
	]);
	for (const spec of specs) {
		const version = spec.versions[0]!;
		expect(version.unverified).toBe(false);
		expect(Object.values(version.builds)[0]!.verification?.passed).toBe(true);
	}
});

test('admins review a customization in plain language, approve it, and it appears', async ({ page }) => {
	await login(page, 'admin');
	await page.goto('/wp-admin/index.php');
	await expect(page.locator('#graft-waiting-posts')).toHaveCount(0);

	await page.goto('/wp-admin/tools.php?page=graft-customizations');
	const card = page.locator('[data-graft-spec="waiting-posts"]');
	await expect(card.locator('[data-graft-state]')).toHaveText('Needs approval');
	await expect(card.locator('.graft-permissions')).toContainText('See posts you can edit, including drafts and pending posts (not granted yet)');
	await expect(card.locator('.graft-checks')).toContainText('Shows at most five posts');
	await expect(card.locator('.graft-checks')).toContainText(
		'Given an editor "e" and no posts, when "e" opens it, then the list is empty and the page says "Nothing is waiting".',
	);
	await page.screenshot({ path: 'test-results/customizations.png', fullPage: true });

	await card.getByRole('button', { name: 'Approve' }).click();
	await expect(card.locator('[data-graft-state]')).toHaveText('Active');
	await expect(card.locator('.graft-permissions')).toContainText('(granted)');

	await page.goto('/wp-admin/index.php');
	const widget = page.locator('#graft-waiting-posts');
	await expect(widget).toContainText('Waiting for review');
	await expect(widget.locator('[data-graft-empty]')).toHaveText('Nothing is waiting');
});

/** Whether wp-admin verifies builds in Playground in the browser (CI only). */
const browserVerify = process.env.GRAFT_E2E_BROWSER_VERIFY === '1';

const copySource = readFileSync(new URL('../../../examples/specs/waiting-posts.md', import.meta.url), 'utf8')
	.replace('id: waiting-posts', 'id: waiting-copy')
	.replace('# Waiting for review', '# Waiting (copy)');

test('admins write a spec in wp-admin, see it validated, and build it', async ({ page }) => {
	test.setTimeout(240_000);
	await login(page, 'admin');
	await page.goto('/wp-admin/tools.php?page=graft-customizations');
	await page.getByRole('button', { name: 'New customization' }).click();
	const editor = page.locator('#graft-spec-source');

	await editor.fill(copySource.replace('posts:read', 'posts:delete'));
	await expect(page.locator('.graft-diagnostics')).toContainText('Line 10:');
	await expect(page.getByRole('button', { name: 'Build it' })).toBeDisabled();

	await editor.fill(copySource);
	await expect(page.locator('.graft-diagnostics')).toContainText('Valid for this site.');
	await page.getByRole('button', { name: 'Build it' }).click();
	const card = page.locator('[data-graft-spec="waiting-copy"]');
	if (browserVerify) {
		// Checks ran in a private WordPress in this browser. The notice says why when they could not.
		const notice = page.locator('.components-notice__content', { hasText: '"Waiting (copy)" was built' });
		await expect(notice).toBeVisible({ timeout: 180_000 });
		await expect(notice).toContainText('"Waiting (copy)" was built and verified.');
		await expect(card.locator('[data-graft-state]').first()).toHaveText('Needs approval');
		await expect(card).toContainText('verified');
	} else {
		await expect(page.locator('.components-notice__content', { hasText: '"Waiting (copy)" was built.' })).toBeVisible({ timeout: 30_000 });
		await expect(card.locator('[data-graft-state]')).toHaveText('Draft');
		await expect(card).toContainText('not verified yet');
	}
	await expect(page.locator('.graft-build-log')).toHaveCount(0);
	await expect(card.locator('.graft-checks')).toContainText('Shows at most five posts');
});

const graft = async (...args: string[]) => {
	const password = readFileSync(new URL('../../../test-results/e2e-fixtures/app-password.txt', import.meta.url), 'utf8').trim();
	const { stdout } = await promisify(execFile)(
		'npx',
		['tsx', 'packages/cli/src/main.ts', ...args, '--site', 'http://127.0.0.1:9400', '--user', 'admin', '--password', password],
		{ cwd: new URL('../../..', import.meta.url).pathname, timeout: 300_000 },
	);
	return stdout;
};

test('graft site verify verifies the draft built in wp-admin, and the admin approves it', async ({ page }) => {
	test.setTimeout(360_000);
	const output = await graft('site', 'verify');
	expect(output).toContain(
		browserVerify ? 'Nothing to verify: every build on the site has a passing verification.' : 'waiting-copy v1  ✔ verified → needs approval',
	);

	await login(page, 'admin');
	await page.goto('/wp-admin/tools.php?page=graft-customizations');
	const card = page.locator('[data-graft-spec="waiting-copy"]');
	await expect(card.locator('[data-graft-state]')).toHaveText('Needs approval');
	await card.getByRole('button', { name: 'Approve' }).click();
	await expect(card.locator('[data-graft-state]')).toHaveText('Active');
	await page.goto('/wp-admin/index.php');
	await expect(page.locator('#graft-waiting-copy [data-graft-empty]')).toHaveText('Nothing is waiting');
});

test('graft site pull exports the active customizations as a canary corpus', async () => {
	const out = new URL('../../../test-results/pulled/e2e-site', import.meta.url).pathname;
	const output = await graft('site', 'pull', '--out', out);
	expect(output).toContain('Wrote 8 customization(s)');
	for (const spec of ['review-queue', 'quick-approve', 'stale-drafts', 'headline-check', 'pending-by-author', 'publish-checklist', 'waiting-posts', 'waiting-copy']) {
		expect(existsSync(`${out}/${spec}.md`) && existsSync(`${out}/${spec}.json`) && existsSync(`${out}/${spec}.grant.json`)).toBe(true);
	}
	expect(JSON.parse(readFileSync(`${out}/review-queue.grant.json`, 'utf8'))).toEqual({ scopes: ['posts:read', 'posts.status:write'] });
});

test('only administrators may use the model proxy', async ({ page }) => {
	await login(page, 'editor');
	const status = await page.evaluate(async () => {
		try {
			await window.wp.apiFetch({ path: '/graft/v1/generate', method: 'POST', data: { purpose: 'ui', system: '', prompt: '', schema: {} } });
			return 'allowed';
		} catch (error) {
			return (error as { code: string }).code;
		}
	});
	expect(status).toBe('rest_forbidden');
});

test('subscribers get no review queue', async ({ page }) => {
	await login(page, 'subscriber');
	const response = await page.goto('/wp-admin/admin.php?page=graft-review-queue');
	expect(response?.status()).toBe(403);
});

// Last, because it renames and publishes Draft B.
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
	await page.screenshot({ path: 'test-results/publish-checklist.png' });

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
});

interface EditorData {
	wp: {
		data: {
			dispatch(store: 'core/editor'): { editPost(edits: Record<string, unknown>): void };
			select(store: 'core/editor'): { isEditedPostDirty(): boolean };
		};
	};
}

declare global {
	interface Window {
		wp: { apiFetch(options: { path: string; method?: string; data?: unknown }): Promise<unknown> };
	}
}
