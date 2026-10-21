import { expect, test } from './fixtures.ts';

/**
 * The browser host end to end: the unpacked extension in Chromium on the
 * Tasklet fixture app. A customization is approved on the options page,
 * injected into the project sidebar, and acts through the service worker's
 * gateway with the person's own session; what is not allowed is refused
 * before it reaches the app.
 */

const panel = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'My open tasks' });

test('nothing is injected until the customization is approved on the options page', async ({ signIn, context, extensionId, approve }) => {
	const before = await signIn('ada');
	await before.waitForTimeout(1_000);
	await expect(before.locator('graft-customization')).toHaveCount(0);

	const options = await context.newPage();
	await options.goto(`chrome-extension://${extensionId}/options.html`);
	const section = options.locator('section', { has: options.getByRole('heading', { name: 'My open tasks' }) });
	await expect(section.getByText('Waiting for approval.')).toBeVisible();
	// What it may do, in plain language, and each check next to its criterion.
	await expect(section.getByText("See a project's tasks")).toBeVisible();
	await expect(section.getByText('Mark tasks done')).toBeVisible();
	await expect(section.getByText('Guests do not get the "Done" button')).toBeVisible();
	await expect(section.getByText(/Given a guest "g" and an open task "Read me"/)).toBeVisible();
	await options.close();

	await approve('My open tasks');
	const after = await signIn('ada');
	await expect(panel(after)).toBeVisible();
});

test('the customization is drawn in the sidebar and styled under the page’s strict CSP', async ({ signIn, approve, app }) => {
	await approve('My open tasks');
	const page = await signIn('ada');
	const response = await page.request.get(`${app.url}/projects/launch`);
	expect(response.headers()['content-security-policy']).toContain("style-src 'self'");

	const sidebar = page.getByRole('complementary', { name: 'Project details' });
	const box = sidebar.getByRole('region', { name: 'My open tasks' });
	await expect(box).toBeVisible();
	const rows = box.getByRole('row');
	// Ada's open tasks only: not her done one, not Lin's.
	await expect(rows).toHaveText([/Task\s*Due/, /Write launch post/, /Check redirects/]);
	await expect(box.getByRole('cell').filter({ hasText: /\d{4}-\d{2}-\d{2}/ }).first()).toHaveAttribute('data-tone', 'error');
	// The constructed stylesheet applies, although the page allows no inline styles.
	await expect(box).toHaveCSS('border-top-style', 'solid');
	// The app's own styles do not reach into the customization.
	await expect(box.getByRole('button', { name: 'Done' }).first()).toHaveCSS('background-color', 'rgb(34, 113, 177)');
});

test('"Done" marks a task done through the gateway, with the person’s session', async ({ signIn, approve, app }) => {
	await approve('My open tasks');
	const page = await signIn('ada');
	const box = panel(page);
	await box.getByRole('row', { name: /Check redirects/ }).getByRole('button', { name: 'Done' }).click();
	await expect(box.getByRole('status')).toHaveText('Marked done.');
	await expect(box.getByRole('row')).toHaveText([/Task\s*Due/, /Write launch post/]);
	expect(app.log()).toContain('POST /api/tasks/t2/complete');
});

test('a guest gets no "Done" button, and a forged click is refused before it reaches the app', async ({ signIn, approve, app, worker }) => {
	await approve('My open tasks');
	const page = await signIn('grace');
	const box = panel(page);
	await expect(box.getByRole('row', { name: /Proofread FAQ/ })).toBeVisible();
	await expect(box.getByRole('button', { name: 'Done' })).toHaveCount(0);

	// What a compromised page could send as the content script: the key of the button it was not shown, and a capability by name.
	const url = page.url();
	const forged = await worker.evaluate(async (url) => {
		const graft = (globalThis as unknown as { graft: { handle(message: unknown, sender: unknown): Promise<unknown> } }).graft;
		const sender = { id: chrome.runtime.id, tab: { id: 1 }, frameId: 0, url };
		return {
			act: await graft.handle({ type: 'act', id: 'my-tasks', key: 'my-tasks:t0:0:t5' }, sender),
			call: await graft.handle({ type: 'call', capability: 'members.list', input: {} }, sender),
			other: await graft.handle({ type: 'render', id: 'my-tasks' }, { ...sender, url: 'https://example.com/projects/launch' }),
		};
	}, url);
	expect(forged.act).toMatchObject({ ok: true, value: { notice: { tone: 'error', text: 'That action is not available.' } } });
	expect(forged.call).toEqual({ ok: false, error: 'Unknown message.' });
	expect(forged.other).toMatchObject({ ok: false });
	expect(app.log().filter((line) => line.startsWith('POST') || line.includes('/api/members'))).toEqual([]);
});

test('a customization whose build calls a capability outside its grant is not served', async ({ signIn, approve, app, worker, context, extensionId }) => {
	await approve('My open tasks');
	// The build changed underneath its approval: it now also loads everyone's email addresses.
	await worker.evaluate(async () => {
		const graft = (globalThis as unknown as { graft: { stored(): Promise<Record<string, { build: { data: Record<string, unknown> } }>>; store(value: unknown): Promise<void> } }).graft;
		const customizations = await graft.stored();
		customizations['my-tasks']!.build.data.members = { call: 'members.list', input: {} };
		await graft.store(customizations);
	});
	const page = await signIn('ada');
	await page.waitForTimeout(1_000);
	await expect(page.locator('graft-customization')).toHaveCount(0);
	expect(app.log().filter((line) => line.includes('/api/members'))).toEqual([]);

	const options = await context.newPage();
	await options.goto(`chrome-extension://${extensionId}/options.html`);
	await expect(options.getByText('Approved, but not shown: It needs permissions that were not approved: members:read.')).toBeVisible();
});

test('when the app changes, the anchor is found again by its landmark and the drift is recorded', async ({ signIn, approve, app, worker }) => {
	await approve('My open tasks');
	app.setVersion(2);
	const page = await signIn('ada');
	await expect(page.locator('[data-testid="details-pane"]').getByRole('region', { name: 'My open tasks' })).toBeVisible();

	app.setVersion(3);
	await page.reload();
	await expect(panel(page).getByRole('alert')).toContainText("no longer matches what this customization expects");

	await expect
		.poll(async () =>
			worker.evaluate(async () => ((await chrome.storage.local.get('drift')).drift as Array<{ kind: string; symbol: string; details: string[] }> | undefined ?? []).map((d) => `${d.kind} ${d.symbol} ${d.details[0]}`)),
		)
		.toEqual(expect.arrayContaining(['slot project.sidebar moved', expect.stringMatching(/^capability tasks\.list \/tasks\/\d+ is missing "due"/)]));
});
