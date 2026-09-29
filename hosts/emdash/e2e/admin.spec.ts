import { expect, test, type Page } from '@playwright/test';

/**
 * Graft customizations in the real EmDash admin, as people with different
 * roles see them. The server (server.ts) installs and approves the three
 * examples and seeds "Hello world" (published) and two drafts, "Draft
 * ideas" and "Release notes". Tests run in order and share that state.
 */

const roles = { contributor: 20, author: 30, editor: 40, admin: 50 } as const;

async function signIn(page: Page, user: keyof typeof roles, path: string): Promise<void> {
	await page.goto(`/graft-test/login?user=${user}&role=${roles[user]}&redirect=${encodeURIComponent(path)}`);
	await expect(page.getByText('Loading EmDash')).toHaveCount(0, { timeout: 60_000 });
	// First sign-in greets the new account.
	const welcome = page.getByRole('button', { name: 'Get Started' });
	if (await welcome.isVisible({ timeout: 3_000 }).catch(() => false)) {
		await welcome.click();
	}
}

const customizations = '/_emdash/admin/plugins/graft/customizations';

test('contributors see the publish queue without Publish buttons', async ({ page }) => {
	await signIn(page, 'contributor', customizations);
	await expect(page.getByRole('row', { name: /Draft ideas/ })).toBeVisible();
	await expect(page.getByRole('row', { name: /Release notes/ })).toBeVisible();
	await expect(page.getByRole('row', { name: /Hello world/ })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Publish' })).toHaveCount(0);
	// Customizations for editors only are not in the sidebar's widget either.
	await page.goto('/_emdash/admin');
	await expect(page.getByText('No customizations here yet.')).toBeVisible();
});

test('administrators get a tab per customization and review each one', async ({ page }) => {
	await signIn(page, 'admin', customizations);
	await expect(page.getByRole('tab', { name: 'Publish queue' })).toBeVisible();
	await page.getByRole('tab', { name: 'Manage' }).click();
	// Each customization with its state, permissions and checks in plain language.
	await expect(page.getByText('Drafts at a glance')).toBeVisible();
	await expect(page.getByText('Go live from the editor')).toBeVisible();
	await expect(page.getByText('Publish and unpublish content').first()).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Only draft posts are listed' })).toBeVisible();
	await expect(page.getByText(/Given an editor "e" and a draft post "Draft A", when "e" opens it, and uses "publish" on "Draft A"/)).toBeVisible();
});

test('the dashboard widget lists drafts for editors', async ({ page }) => {
	await signIn(page, 'editor', '/_emdash/admin');
	// EmDash's own "Drafts" count card comes first; the widget's heading is ours.
	await expect(page.getByRole('heading', { name: 'Drafts', exact: true }).last()).toBeVisible();
	await expect(page.getByRole('row', { name: /Release notes/ })).toBeVisible();
	await expect(page.getByRole('row', { name: /Draft ideas/ })).toBeVisible();
});

test('editors publish a draft from the publish queue', async ({ page }) => {
	await signIn(page, 'editor', customizations);
	const row = page.getByRole('row', { name: /Release notes/ });
	await row.getByRole('button', { name: 'Publish' }).click();
	await expect(page.getByText('Published.')).toBeVisible();
	await expect(page.getByRole('row', { name: /Release notes/ })).toHaveCount(0);
	await expect(page.getByRole('row', { name: /Draft ideas/ })).toBeVisible();

	// EmDash agrees: the post is live.
	await page.goto('/_emdash/admin/content/posts');
	await expect(page.getByRole('row', { name: /Release notes/ })).toContainText(/published/i);
});

test('editors take a post live from the editor panel', async ({ page }) => {
	await signIn(page, 'editor', '/_emdash/admin/content/posts');
	await page.getByRole('link', { name: 'Draft ideas' }).first().click();
	await expect(page.getByRole('heading', { name: 'Edit Post' })).toBeVisible();

	const panel = page.getByRole('button', { name: 'Customizations', exact: true });
	await panel.click();
	await expect(page.getByText('Not live', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Go live' }).click();
	await expect(page.getByText('The post is live.')).toBeVisible();
	await expect(page.getByText('Live', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Take offline' })).toBeVisible();
});

test('administrators write a customization in the admin', async ({ page }) => {
	const { authoredSpec } = await import('./authoring.ts');
	await signIn(page, 'admin', customizations);
	await page.getByRole('tab', { name: 'Manage' }).click();
	const editor = page.getByLabel('Spec');
	await editor.fill(authoredSpec);
	await page.getByRole('button', { name: 'Build it' }).click();
	// One model call per step: the checks first...
	await expect(page.getByText('Step 1 done. Continue to take the next step.')).toBeVisible();
	await page.getByRole('button', { name: 'Continue building' }).click();
	// ...then the tree, which is stored as a draft until it is verified.
	await expect(page.getByText('"Recent drafts" is built. Verify it, then approve it.')).toBeVisible();
	await expect(page.getByText('Built (not verified)')).toBeVisible();
	await expect(page.getByText('Draft (not verified)')).toBeVisible();
});
