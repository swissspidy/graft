import { defineConfig } from '@playwright/test';

// The unpacked extension must be built first (pnpm build:extension); pnpm test:e2e:extension does both.
export default defineConfig({
	testDir: '.',
	testMatch: '*.spec.ts',
	timeout: 60_000,
	expect: { timeout: 10_000 },
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	use: { trace: 'retain-on-failure' },
});
