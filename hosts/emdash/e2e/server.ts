import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExamples } from '../adapter/src/node/examples.ts';
import { startSandbox, verifyInEmDash } from '../adapter/src/node/sandbox.ts';
import { pluginRoute } from '../adapter/src/node/server.ts';

/**
 * A seeded EmDash for the browser tests and for trying Graft by hand: the
 * example customizations verified, installed and approved, and a few posts.
 * /graft-test/ready answers 200 once all of that is done.
 *
 *   pnpm exec tsx hosts/emdash/e2e/server.ts   (port 4480, or GRAFT_E2E_PORT)
 *
 * Sign in with /graft-test/login?user=editor&role=40&redirect=/_emdash/admin
 * (roles: 20 contributor, 30 author, 40 editor, 50 admin).
 */

const port = Number(process.env.GRAFT_E2E_PORT ?? 4480);
const marker = await mkdtemp(join(tmpdir(), 'graft-e2e-'));
const ready = join(marker, 'ready');
const sandbox = await startSandbox({
	port,
	testLogin: true,
	env: { GRAFT_READY_FILE: ready },
	log: process.env.GRAFT_E2E_VERBOSE ? (l) => process.stderr.write(l) : undefined,
});
const server = sandbox.server;
const shutdown = async () => {
	await rm(marker, { recursive: true, force: true });
	await sandbox.close();
	process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const examples = await loadExamples();
const verifications = await verifyInEmDash(examples, { sandbox });
for (const [i, example] of examples.entries()) {
	if (!verifications[i]!.passed) {
		throw new Error(`${example.name} does not pass its checks.`);
	}
	await pluginRoute(server, 'install', { source: example.source, build: example.build, verification: verifications[i] });
	await pluginRoute(server, 'approve', { id: example.name });
}
await pluginRoute(server, 'sandbox', { op: 'reset' });
await pluginRoute(server, 'sandbox', {
	op: 'seed',
	fixtures: { entries: [{ title: 'Hello world', status: 'published' }, { title: 'Draft ideas', status: 'draft' }, { title: 'Release notes', status: 'draft' }] },
});
if (process.env.GRAFT_E2E_INFO) {
	await writeFile(process.env.GRAFT_E2E_INFO, JSON.stringify({ url: server.url, token: server.token }));
}
await writeFile(ready, '');
console.log(`Graft on EmDash is ready at ${server.url}/_emdash/admin`);
