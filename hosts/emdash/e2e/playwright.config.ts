import { defineConfig } from '@playwright/test';

const port = Number(process.env.GRAFT_E2E_PORT ?? 4480);

export default defineConfig({
	testDir: '.',
	testMatch: '*.spec.ts',
	timeout: 90_000,
	expect: { timeout: 20_000 },
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		trace: 'retain-on-failure',
		viewport: { width: 1400, height: 1000 },
		// A Chromium other than the one this Playwright version downloads, e.g. CHROMIUM=/opt/pw-browsers/chromium.
		...(process.env.CHROMIUM ? { launchOptions: { executablePath: process.env.CHROMIUM } } : {}),
	},
	webServer: {
		command: 'tsx hosts/emdash/e2e/server.ts',
		cwd: '../../..',
		url: `http://127.0.0.1:${port}/graft-test/ready`,
		timeout: 300_000,
		reuseExistingServer: !process.env.CI,
		stdout: 'pipe',
	},
});
