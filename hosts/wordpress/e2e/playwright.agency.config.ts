import { defineConfig } from '@playwright/test';

/** The agency end-to-end tests, against the Riverside site (agency-server.ts). */
export default defineConfig({
	testDir: '.',
	testMatch: 'agency.spec.ts',
	timeout: 90_000,
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	use: {
		baseURL: 'http://127.0.0.1:9402',
		trace: 'retain-on-failure',
		// A Chromium other than the one this Playwright version downloads, e.g. CHROMIUM=/opt/pw-browsers/chromium.
		...(process.env.CHROMIUM ? { launchOptions: { executablePath: process.env.CHROMIUM } } : {}),
	},
	webServer: {
		command: 'pnpm build && tsx hosts/wordpress/e2e/agency-server.ts',
		cwd: '../../..',
		url: 'http://127.0.0.1:9402/wp-login.php',
		timeout: 300_000,
		reuseExistingServer: !process.env.CI,
		stdout: 'pipe',
	},
});
