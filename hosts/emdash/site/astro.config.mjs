import node from '@astrojs/node';
import react from '@astrojs/react';
import { graft, graftSandboxed } from '@graft/emdash';
import { defineConfig } from 'astro/config';
import emdash, { local } from 'emdash/astro';
import { sqlite } from 'emdash/db';

// GRAFT_FORMAT=sandboxed runs the plugin in EmDash's plugin sandbox (workerd)
// instead of in-process; GRAFT_SANDBOX=1 adds the verification sandbox route
// (native only); GRAFT_ALLOWED_HOSTS lets tests point the model at a stub.
const sandboxed = process.env.GRAFT_FORMAT === 'sandboxed';
const allowedHosts = (process.env.GRAFT_ALLOWED_HOSTS || '').split(',').filter(Boolean);

export default defineConfig({
	output: 'server',
	adapter: node({ mode: 'standalone' }),
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: process.env.EMDASH_TEST_DB || 'file:./data.db' }),
			storage: local({ directory: './uploads', baseUrl: '/_emdash/api/media/file' }),
			plugins: sandboxed ? [] : [graft({ sandbox: process.env.GRAFT_SANDBOX === '1', allowedHosts })],
			sandboxed: sandboxed ? [graftSandboxed({ allowedHosts })] : [],
			sandboxRunner: '@emdash-cms/sandbox-workerd',
			// Test-only: routes Claude API requests to a stub (see the file).
			middleware: { outer: './src/test-model.ts' },
		}),
	],
	devToolbar: { enabled: false },
});
