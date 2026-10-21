import { fileURLToPath } from 'node:url';
import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { startTasklet, type TaskletServer } from '../fixtures/tasklet/server.ts';

/**
 * Chromium with the unpacked extension (hosts/chrome-extension/adapter/dist/extension)
 * and a fresh Tasklet fixture app with its demo data, per test. CHROMIUM picks the
 * browser, e.g. CHROMIUM=/opt/pw-browsers/chromium. Extensions need a persistent
 * context and Chromium's new headless mode: Playwright's default headless shell
 * cannot load them, hence the "chromium" channel otherwise.
 */

const extension = fileURLToPath(new URL('../adapter/dist/extension', import.meta.url));

export interface Fixtures {
	app: TaskletServer;
	context: BrowserContext;
	worker: Worker;
	extensionId: string;
	/** Signs in to Tasklet as a user and opens a project page. */
	signIn(user: 'ada' | 'grace' | 'lin', project?: string): Promise<Page>;
	/** Approves a customization on the extension's options page, as a person would. */
	approve(title: string): Promise<void>;
}

export const test = base.extend<Fixtures>({
	app: async ({}, use) => {
		const app = await startTasklet();
		await use(app);
		await app.close();
	},
	context: async ({}, use) => {
		const context = await chromium.launchPersistentContext('', {
			headless: true,
			...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: 'chromium' }),
			args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
		});
		await use(context);
		await context.close();
	},
	worker: async ({ context }, use) => {
		const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
		await use(worker);
	},
	extensionId: async ({ worker }, use) => {
		await use(new URL(worker.url()).host);
	},
	signIn: async ({ app, context }, use) => {
		await use(async (user, project = 'launch') => {
			const page = await context.newPage();
			await page.goto(`${app.url}/login?as=${user}&next=/projects/${project}`);
			await page.getByRole('complementary', { name: 'Project details' }).waitFor();
			return page;
		});
	},
	approve: async ({ context, extensionId }, use) => {
		await use(async (title) => {
			const page = await context.newPage();
			await page.goto(`chrome-extension://${extensionId}/options.html`);
			const section = page.locator('section', { has: page.getByRole('heading', { name: title }) });
			await section.getByRole('button', { name: 'Approve' }).click();
			await section.getByText('Approved: shown in the app.').waitFor();
			await page.close();
		});
	},
});

export { expect } from '@playwright/test';
