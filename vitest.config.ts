import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const wordpressStub = fileURLToPath(new URL('hosts/wordpress/adapter/test/stubs/wordpress.ts', import.meta.url));

export default defineConfig({
	resolve: {
		// The client bundle maps these to window.wp.*; tests use stand-ins.
		alias: {
			'@wordpress/api-fetch': wordpressStub,
			'@wordpress/components': wordpressStub,
			// The client bundles a2ui-wp from its copy (see scripts/build-client.ts).
			'a2ui-wp': fileURLToPath(new URL('packages/a2ui-wp/src/index.ts', import.meta.url)),
		},
	},
	test: {
		include: ['packages/*/test/**/*.test.{ts,tsx}', 'hosts/*/adapter/test/**/*.test.{ts,tsx}'],
		setupFiles: ['packages/core/test/setup/engine.ts'],
	},
});
