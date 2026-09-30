import { expect, test, type Page } from '@playwright/test';

/**
 * The agency angle, on the Riverside Arts Centre (playground/sites/riverside.php):
 * a client site whose agency, Lumen Studio, exposes events with custom fields
 * and types, limits what the centre's administrators may allow, and ships a
 * customization it manages itself. Seeded by playground/seed-agency.php.
 * Tests run in order.
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

const customizations = '/wp-admin/tools.php?page=graft-customizations';
const listRow = (page: Page, title: string) => page.locator('#the-list tr', { hasText: title });

/** A REST call as the logged-in user, answering its error code when refused. */
const rest = (page: Page, path: string, data?: unknown) =>
	page.evaluate(
		async ({ path, data }) => {
			try {
				return await window.wp.apiFetch(data === undefined ? { path } : { path, method: 'POST', data });
			} catch (error) {
				return { error: (error as { code: string }).code };
			}
		},
		{ path, data },
	);

test("administrators see the agency's policy and the customization it manages", async ({ page }) => {
	await login(page, 'admin');
	await page.goto(customizations);
	const policy = page.locator('[data-graft-policy]');
	await expect(policy).toContainText('This site is maintained by Lumen Studio.');
	await expect(policy).toContainText('Customizations can go in: Dashboard widget, Posts list row actions, Post editor panel.');
	await expect(policy).toContainText('change the custom fields of posts you can edit');
	await expect(policy).not.toContainText('Publish');

	const managed = page.locator('[data-graft-spec="upcoming-events"]');
	await expect(managed).toContainText('Managed by Lumen Studio');
	await expect(managed.locator('[data-graft-state]')).toHaveText('Active');
	await expect(managed.getByRole('button')).toHaveCount(0);
	await page.screenshot({ path: 'test-results/agency-customizations.png', fullPage: true });
});

test('editors see upcoming events soonest first from custom fields, and mark one sold out', async ({ page }) => {
	await login(page, 'editor');
	await page.goto('/wp-admin/index.php');
	const widget = page.locator('#graft-upcoming-events');
	await expect(widget.locator('tbody tr [data-graft-field="title"]')).toHaveText(['Poetry slam', 'Open rehearsal', 'Jazz night', 'Puppet show']);
	const cell = (title: string, field: string) => widget.locator('tbody tr', { hasText: title }).locator(`[data-graft-field="${field}"]`);
	await expect(cell('Open rehearsal', 'meta.venue')).toHaveText('Venue missing');
	await expect(cell('Jazz night', 'meta.venue')).toHaveText('Main hall');
	await expect(cell('Jazz night', 'meta.capacity')).toHaveText('240');
	await widget.screenshot({ path: 'test-results/agency-upcoming-events.png' });

	await widget.locator('tbody tr', { hasText: 'Jazz night' }).getByRole('button', { name: 'Mark sold out' }).click();
	await expect(page.locator('.components-notice__content', { hasText: 'Marked sold out.' })).toBeVisible();
	await expect(widget.locator('tbody tr', { hasText: 'Jazz night' }).getByRole('button', { name: 'Mark sold out' })).toHaveCount(0);
	await expect(widget.locator('tbody tr', { hasText: 'Poetry slam' }).getByRole('button', { name: 'Mark sold out' })).toHaveCount(1);
});

test("the policy refuses what the agency does not allow, and the managed customization can't be changed", async ({ page }) => {
	await login(page, 'admin');
	const source = '---\ngraft: 1\nid: go-live\nhost: wordpress\nmount:\n  slot: posts.list.row-actions\n  post_type: event\npermissions:\n  - posts.status:write\n---\n\n# Go live\n\nPublish events.\n\n## Acceptance criteria\n\n- Publishes {#publishes}\n';
	const manifest = { graft: 1, id: 'go-live', host: 'wordpress', mount: { slot: 'posts.list.row-actions', post_type: 'event' }, permissions: ['posts.status:write'] };
	expect(await rest(page, '/graft/v1/specs', { source, manifest })).toEqual({ error: 'graft_policy_scope' });
	expect(await rest(page, '/graft/v1/specs', { source, manifest: { ...manifest, mount: { slot: 'admin.page', menu: { title: 'Go live' } }, permissions: ['posts:read'] } })).toEqual({
		error: 'graft_policy_slot',
	});
	expect(await rest(page, '/graft/v1/specs/upcoming-events/versions/1/archive', {})).toEqual({ error: 'graft_managed' });
});

test("the centre's own Family friendly action is approved and adds the type on the Events screen", async ({ page }) => {
	await login(page, 'admin');
	await page.goto(customizations);
	const card = page.locator('[data-graft-spec="family-friendly"]');
	await expect(card.locator('[data-graft-state]')).toHaveText('Needs approval');
	await expect(card.locator('.graft-permissions')).toContainText('Change the categories, tags and other terms of posts you can edit (not granted yet)');
	await card.getByRole('button', { name: 'Approve' }).click();
	await expect(card.locator('[data-graft-state]')).toHaveText('Active');

	await login(page, 'editor');
	await page.goto('/wp-admin/edit.php?post_type=event');
	await expect(listRow(page, 'Puppet show').locator('[data-graft-action="family-friendly"]')).toHaveCount(0);
	const jazz = listRow(page, 'Jazz night');
	await expect(jazz.locator('[data-graft-action="family-friendly"]')).toHaveCount(1);
	await jazz.hover();
	await Promise.all([page.waitForEvent('load'), jazz.locator('[data-graft-action="family-friendly"]').click()]);
	// WordPress marks each row with its terms; the Events list shows no type column.
	await expect(listRow(page, 'Jazz night')).toHaveClass(/\bevent_type-family\b/);
	await expect(listRow(page, 'Jazz night')).toHaveClass(/\bevent_type-music\b/);
	await expect(listRow(page, 'Jazz night').locator('[data-graft-action="family-friendly"]')).toHaveCount(0);

	await page.goto('/wp-admin/edit.php');
	await expect(page.locator('[data-graft-action="family-friendly"]')).toHaveCount(0);
});

test('when the agency exposes a new field, the site records its surface and carries customizations over', async ({ page }) => {
	test.skip(process.env.GRAFT_E2E_BROWSER_VERIFY !== '1', 'Verifies in Playground in the browser (needs playground.wordpress.net).');
	test.setTimeout(300_000);
	await login(page, 'admin');
	expect(await rest(page, '/riverside-test/v1/release', { release: 2 })).toEqual({ release: 2 });

	// The first admin page after the release finds a surface nobody recorded:
	// no customization is served until Tools → Customizations records it.
	await page.goto(customizations);
	await expect(page.locator('[data-graft-upgrades]')).toContainText('2 customizations are not shown because this site changed', { timeout: 60_000 });
	await page.locator('[data-graft-upgrades]').getByRole('button', { name: 'Check and upgrade' }).click();
	await expect(page.locator('[data-graft-upgrade-outcome="survived"]')).toHaveCount(2, { timeout: 240_000 });
	await expect(page.locator('[data-graft-spec="upcoming-events"] [data-graft-state]')).toHaveText('Active');
	await expect(page.locator('[data-graft-spec="family-friendly"] [data-graft-state]')).toHaveText('Active');

	await login(page, 'editor');
	await page.goto('/wp-admin/index.php');
	await expect(page.locator('#graft-upcoming-events tbody tr')).toHaveCount(4);
});
