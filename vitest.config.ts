import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const wordpressStub = fileURLToPath(new URL('hosts/wordpress/adapter/test/stubs/wordpress.ts', import.meta.url));

export default defineConfig({
	resolve: {
		// The client bundle maps these to window.wp.*; tests use stand-ins.
		alias: {
			'@wordpress/api-fetch': wordpressStub,
			'@wordpress/components': wordpressStub,
			// a2ui-wp 0.1.0 ships its sources only (see scripts/build-client.ts).
			'@swissspidy/a2ui-wp': `${dirname(createRequire(new URL('hosts/wordpress/adapter/package.json', import.meta.url)).resolve('@swissspidy/a2ui-wp/package.json'))}/src/index.ts`,
		},
	},
	test: {
		include: ['packages/*/test/**/*.test.{ts,tsx}', 'hosts/*/adapter/test/**/*.test.{ts,tsx}'],
		setupFiles: ['packages/core/test/setup/engine.ts'],
	},
});
