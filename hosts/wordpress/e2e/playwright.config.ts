import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: '.',
	testMatch: '*.spec.ts',
	testIgnore: ['agency.spec.ts'],
	timeout: 60_000,
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	use: {
		baseURL: 'http://127.0.0.1:9400',
		trace: 'retain-on-failure',
		// A Chromium other than the one this Playwright version downloads, e.g. CHROMIUM=/opt/pw-browsers/chromium.
		...(process.env.CHROMIUM ? { launchOptions: { executablePath: process.env.CHROMIUM } } : {}),
	},
	webServer: {
		command: 'pnpm build && tsx hosts/wordpress/e2e/server.ts',
		cwd: '../../..',
		url: 'http://127.0.0.1:9400/wp-login.php',
		timeout: 300_000,
		reuseExistingServer: !process.env.CI,
		stdout: 'pipe',
	},
});
