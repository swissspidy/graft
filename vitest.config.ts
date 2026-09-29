import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const wordpressStub = fileURLToPath(new URL('hosts/wordpress/adapter/test/stubs/wordpress.ts', import.meta.url));

export default defineConfig({
	resolve: {
		// The client bundle maps these to window.wp.*; tests use stand-ins.
		alias: {
			'@wordpress/api-fetch': wordpressStub,
			'@wordpress/components': wordpressStub,
		},
	},
	test: {
		include: ['packages/*/test/**/*.test.{ts,tsx}', 'hosts/*/adapter/test/**/*.test.{ts,tsx}'],
		setupFiles: ['packages/core/test/setup/engine.ts'],
	},
});
