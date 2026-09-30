import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';

/**
 * Milestone 3: the plugin serves hand-written builds of the example specs
 * in real wp-admin, and the gateway enforces grants.
 *
 * The site is seeded by playground/seed-e2e.php with Draft A and Draft E
 * (pending, by the contributor), Draft B (draft), Post C (published) and
 * Old draft D (a draft last updated forty days ago).
 * Tests run in order because they publish posts.
 */
test.describe.configure({ mode: 'serial' });

async function login(page: Page, user: string) {
	await page.goto('/wp-login.php');
	await page.fill('#user_login', user);
	await page.fill('#user_pass', 'password');
	await page.click('#wp-submit');
	// The admin page's DOM is enough: its images and feeds may be slow to finish loading.
	await page.waitForURL(/wp-admin/, { waitUntil: 'domcontentloaded' });
}

const queue = (page: Page) => page.locator('.graft-page table');
const queueRow = (page: Page, title: string) => queue(page).locator('tbody tr', { hasText: title });
const listRow = (page: Page, title: string) => page.locator('#the-list tr', { hasText: title });

/** What this document fetched of the functions sandbox (the worker's own fetches show up as the worker's). */
const sandboxLoads = (page: Page) =>
	page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((url) => /functions-worker\.js|quickjs\.wasm/.test(url)));

test('the headline check runs its code in the sandbox, loaded only where it is needed', async ({ page }) => {
	await login(page, 'editor');
	const isOurs = (w: { url(): string }) => w.url().includes('functions-worker.js');
	const worker = page.waitForEvent('worker', { predicate: isOurs });

	await page.goto('/wp-admin/index.php');
	const widget = page.locator('#graft-headline-check');
	const verdict = (title: string) => widget.locator('tbody tr', { hasText: title }).locator('[data-graft-field="verdict"] [data-graft-tone]');
	await expect(verdict('Draft A')).toHaveText('Too short');
	await expect(verdict('Draft A')).toHaveAttribute('data-graft-tone', 'warning');
	await expect(verdict('Draft E')).toHaveText('Too short');
	await worker;
	// One worker per build with code on the screen.
	const loads = await sandboxLoads(page);
	expect(loads.length).toBeGreaterThan(0);
	expect(loads.every((url) => url.includes('functions-worker.js'))).toBe(true);

	// The review queue has no code: no worker, no QuickJS.
	await page.goto('/wp-admin/admin.php?page=graft-review-queue');
	await expect(queueRow(page, 'Draft A')).toBeVisible();
	expect(await sandboxLoads(page)).toEqual([]);
	expect(page.workers().filter(isOurs)).toEqual([]);

	await page.goto('/wp-admin/index.php');
	await expect(verdict('Draft A')).toHaveText('Too short');
	await widget.screenshot({ path: 'test-results/headline-check.png' });
});

test('an interactive widget filters pending posts by author, drawn by code in the sandbox', async ({ page }) => {
	await login(page, 'editor');
	// A pending post by a second author, removed again at the end so the other tests see the seeded site.
	const created = (await page.evaluate(() =>
		window.wp.apiFetch({ path: '/wp/v2/posts', method: 'POST', data: { title: 'Editor pitch', status: 'pending' } }),
	)) as { id: number };
	try {
		await page.goto('/wp-admin/index.php');
		const widget = page.locator('#graft-pending-by-author');
		const everyone = widget.locator('[data-graft-action="everyone"]');
		const contributor = widget.locator('[data-graft-action="author-contributor-user"]');
		const editor = widget.locator('[data-graft-action="author-editor-user"]');
		const row = (title: string) => widget.locator('tbody tr', { hasText: title });
		await expect(everyone).toHaveText('Everyone (3)');
		await expect(contributor).toHaveText('Contributor User (2)');
		await expect(editor).toHaveText('Editor User (1)');
		await expect(everyone).toHaveClass(/is-primary/);
		await expect(widget.locator('tbody tr')).toHaveCount(3);

		await contributor.click();
		await expect(contributor).toHaveClass(/is-primary/);
		await expect(widget.locator('tbody tr')).toHaveCount(2);
		await expect(row('Draft A')).toBeVisible();
		await expect(row('Editor pitch')).toHaveCount(0);

		await editor.click();
		await expect(widget.locator('tbody tr')).toHaveCount(1);
		await expect(row('Editor pitch')).toBeVisible();

		await everyone.click();
		await expect(everyone).toHaveClass(/is-primary/);
		await expect(widget.locator('tbody tr')).toHaveCount(3);
		await widget.screenshot({ path: 'test-results/pending-by-author.png' });

		// The widget's declared action, on one of its rows: publishes through the gateway.
		await row('Editor pitch').locator('[data-graft-action="approve"]').click();
		await expect(page.locator('.components-notice__content', { hasText: 'Published.' })).toBeVisible();
		await expect(row('Editor pitch')).toHaveCount(0);
		await expect(widget.locator('tbody tr')).toHaveCount(2);
		const published = (await page.evaluate((id) => window.wp.apiFetch({ path: `/wp/v2/posts/${id}?context=edit` }), created.id)) as { status: string };
		expect(published.status).toBe('publish');
	} finally {
		await page.evaluate((id) => window.wp.apiFetch({ path: `/wp/v2/posts/${id}?force=true`, method: 'DELETE' }), created.id);
	}
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

test('stale drafts show how many days ago each draft was updated, colored by age', async ({ page }) => {
	await login(page, 'editor');
	await page.goto('/wp-admin/index.php');
	const widget = page.locator('#graft-stale-drafts');
	const age = (title: string) => widget.locator('tbody tr', { hasText: title }).locator('[data-graft-field="age"] [data-graft-tone]');
	await expect(age('Old draft D')).toHaveText('40');
	await expect(age('Old draft D')).toHaveAttribute('data-graft-tone', 'error');
	await expect(age('Draft B')).toHaveText('0');
	await expect(age('Draft B')).toHaveAttribute('data-graft-tone', 'success');
	await expect(widget.locator('tbody tr', { hasText: 'Draft A' })).toHaveCount(0);
	await widget.screenshot({ path: 'test-results/stale-drafts.png' });
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
		// Checks ran in a private WordPress in this browser.
		await expect(page.locator('.components-notice__content', { hasText: '"Waiting (copy)" was built and verified.' })).toBeVisible({ timeout: 180_000 });
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
			await window.wp.apiFetch({ path: '/graft/v1/generate', method: 'POST', data: { purpose: 'tree', system: '', prompt: '', schema: {} } });
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
test('the publish checklist sits in the block editor: it follows typing, saves, and publishes', async ({ page }) => {
	await login(page, 'editor');
	// The editor greets first-time users with a guide.
	const guide = page.getByRole('dialog', { name: /welcome/i });
	await page.addLocatorHandler(guide, () => guide.getByRole('button', { name: /close/i }).click());
	await page.goto('/wp-admin/edit.php');
	await page.locator('#the-list').getByRole('link', { name: 'Draft B', exact: true }).first().click();
	const panel = page.locator('.graft-editor-panel');
	const toggle = page.getByRole('button', { name: 'Publish checklist' });
	await toggle.waitFor({ timeout: 60_000 });
	if ((await toggle.getAttribute('aria-expanded')) === 'false') {
		await toggle.click();
	}

	// Drawn by the build's code in the sandbox, from the post as saved.
	await expect(panel.getByLabel('Headline')).toHaveValue('Draft B', { timeout: 30_000 });
	await expect(panel.getByText('✗ Headline is 20 to 70 characters (7 now)')).toBeVisible();
	await expect(panel.getByText('✗ Excerpt of at least 50 characters (0 now)')).toBeVisible();

	// It follows typing, before anything is saved.
	await panel.getByLabel('Headline').fill('Draft B gets a headline that fits');
	await expect(panel.getByText('✓ Headline is 20 to 70 characters')).toBeVisible();
	await panel.getByLabel('Excerpt').fill('A short summary of the post, for search results and social media.');
	await panel.getByLabel('Facts and names checked').check();
	await expect(panel.getByText('✓ Facts and names checked')).toBeVisible();
	await expect(panel.getByText('Save your changes before publishing.')).toBeVisible();
	await expect(panel.getByRole('button', { name: 'Publish' })).toHaveCount(0);

	// While the editor has unsaved changes of its own, nothing is written.
	await page.evaluate(() => (window.wp as unknown as EditorData).data.dispatch('core/editor').editPost({ title: 'Draft B, edited in the editor' }));
	await panel.getByRole('button', { name: 'Save' }).click();
	await expect(panel.getByText('Save or discard your changes to the post first.')).toBeVisible();
	await page.evaluate(() => (window.wp as unknown as EditorData).data.dispatch('core/editor').editPost({ title: 'Draft B' }));
	await expect.poll(() => page.evaluate(() => (window.wp as unknown as EditorData).data.select('core/editor').isEditedPostDirty())).toBe(false);

	// Saving writes what is on screen and reloads the editor with it. (The fields show the typed
	// values before the reload too, so wait for the reload itself.)
	const saved = page.waitForEvent('load', { timeout: 60_000 });
	await panel.getByRole('button', { name: 'Save' }).click();
	await saved;
	await expect(panel.getByLabel('Headline')).toHaveValue('Draft B gets a headline that fits', { timeout: 60_000 });
	await expect(panel.getByLabel('Excerpt')).toHaveValue('A short summary of the post, for search results and social media.');

	// Once everything is ticked and saved, editors can publish.
	await panel.getByLabel('Facts and names checked').check();
	const published = page.waitForEvent('load', { timeout: 60_000 });
	await panel.getByRole('button', { name: 'Publish' }).click();
	await published;
	await page.goto('/wp-admin/edit.php?post_status=publish&post_type=post');
	await expect(page.locator('#the-list')).toContainText('Draft B gets a headline that fits');
});

interface EditorData {
	data: {
		dispatch(store: 'core/editor'): { editPost(edits: Record<string, unknown>): void };
		select(store: 'core/editor'): { isEditedPostDirty(): boolean };
	};
}

declare global {
	interface Window {
		wp: { apiFetch(options: { path: string; method?: string; data?: unknown }): Promise<unknown> };
	}
}
