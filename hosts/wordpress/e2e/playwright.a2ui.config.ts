import { defineConfig } from '@playwright/test';

/** The A2UI end-to-end tests: the example specs built as A2UI surfaces (a2ui-server.ts). */
export default defineConfig({
	testDir: '.',
	testMatch: 'a2ui.spec.ts',
	timeout: 90_000,
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	use: {
		baseURL: 'http://127.0.0.1:9403',
		trace: 'retain-on-failure',
		// A Chromium other than the one this Playwright version downloads, e.g. CHROMIUM=/opt/pw-browsers/chromium.
		...(process.env.CHROMIUM ? { launchOptions: { executablePath: process.env.CHROMIUM } } : {}),
	},
	webServer: {
		command: 'pnpm build && tsx hosts/wordpress/e2e/a2ui-server.ts',
		cwd: '../../..',
		url: 'http://127.0.0.1:9403/wp-login.php',
		timeout: 300_000,
		reuseExistingServer: !process.env.CI,
		stdout: 'pipe',
	},
});
