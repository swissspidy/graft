import node from '@astrojs/node';
import react from '@astrojs/react';
import { graft } from '@graft/emdash';
import { defineConfig } from 'astro/config';
import emdash, { local } from 'emdash/astro';
import { sqlite } from 'emdash/db';

export default defineConfig({
	output: 'server',
	adapter: node({ mode: 'standalone' }),
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: process.env.EMDASH_TEST_DB || 'file:./data.db' }),
			storage: local({ directory: './uploads', baseUrl: '/_emdash/api/media/file' }),
			plugins: [graft({ sandbox: process.env.GRAFT_SANDBOX === '1' })],
		}),
	],
	devToolbar: { enabled: false },
});
