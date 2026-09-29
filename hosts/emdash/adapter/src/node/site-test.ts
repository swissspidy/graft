import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from './examples.ts';
import { pluginRoute, startEmDash } from './server.ts';

/**
 * graft site against a live EmDash (no sandbox route): install with local
 * verification, install unverified then verify from the terminal, approve,
 * and pull the site as a canary tenant. Runs the real CLI.
 */

const run = promisify(execFile);
const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, detail: ok ? undefined : detail });

const site = await startEmDash();
const out = await mkdtemp(join(tmpdir(), 'graft-site-'));
const graft = async (...args: string[]) => {
	try {
		const { stdout } = await run('pnpm', ['-s', 'graft', 'site', ...args, '--site', site.url, '--token', site.token], { cwd: ROOT, maxBuffer: 1 << 24 });
		return { code: 0, stdout };
	} catch (error) {
		const e = error as { code?: number; stdout?: string; stderr?: string };
		return { code: e.code ?? 1, stdout: `${e.stdout ?? ''}${e.stderr ?? ''}` };
	}
};
type Record = { id: string; versions: Array<{ n: number; state: string; verification?: { passed: boolean } }>; grant: string[] };
const specs = async () => (await pluginRoute<{ specs: Record[] }>(site, 'specs')).specs;

try {
	const sandboxRoute = await pluginRoute(site, 'sandbox', { op: 'dump' }).then(
		() => true,
		() => false,
	);
	check('a live site has no sandbox route', !sandboxRoute);

	const installed = await graft('install', 'examples/emdash/specs/publish-queue.md', 'examples/emdash/builds/publish-queue.json');
	check('install verifies locally and the build waits for approval', installed.code === 0 && installed.stdout.includes('publish-queue v1: needs approval (5/5 checks passed)'), installed);

	const draft = await graft('install', 'examples/emdash/specs/go-live.md', 'examples/emdash/builds/go-live.json', '--no-verify');
	check('install --no-verify leaves a draft', draft.code === 0 && draft.stdout.includes('go-live v1: draft (not verified)'), draft);

	const broken = await graft('install', 'examples/emdash/specs/go-live.md', 'examples/emdash/builds/drafts-glance.json');
	check('a build for another spec is refused before anything is sent', broken.code !== 0 && broken.stdout.includes('not valid for this spec'), broken);

	const verified = await graft('verify');
	check('site verify verifies the draft and attaches the result', verified.code === 0 && verified.stdout.includes('go-live v1  ✔ verified → needs approval'), verified);
	const again = await graft('verify');
	check('nothing is left to verify', again.stdout.includes('Nothing to verify'), again);

	const before = await specs();
	check('verifications are stored', before.every((r) => r.versions.at(-1)?.verification?.passed === true), before);

	for (const id of ['publish-queue', 'go-live']) {
		await pluginRoute(site, 'approve', { id });
	}
	const pulled = await graft('pull', '--out', join(out, 'tenant'));
	const files = (await readdir(join(out, 'tenant'))).sort();
	check('pull writes the active customizations as a tenant', pulled.code === 0 && files.join(',') === 'go-live.grant.json,go-live.json,go-live.md,publish-queue.grant.json,publish-queue.json,publish-queue.md', { pulled, files });
	const grant = JSON.parse(await readFile(join(out, 'tenant', 'publish-queue.grant.json'), 'utf8')) as { scopes: string[] };
	check('the pulled grant is what was approved', grant.scopes.join(',') === 'content.status:write,content:read', grant);

	const canary = await run('pnpm', ['-s', 'graft', 'canary', '--corpus', out, '--from', 'hosts/emdash/adapter/surfaces/1.0.json', '--scenario', 'widen-publish-scope'], { cwd: ROOT, maxBuffer: 1 << 24 }).then(
		(r) => r.stdout,
		(e: { stdout?: string }) => e.stdout ?? '',
	);
	check('the pulled tenant runs through the canary', canary.includes('tenant / publish-queue  needs approval') && canary.includes('tenant / go-live        needs approval'), canary);
} finally {
	await site.close();
	await rm(out, { recursive: true, force: true });
}

for (const c of checks) {
	console.log(`  ${c.ok ? '✔' : '✖'} ${c.name}`);
	if (!c.ok) {
		console.log(`      ${JSON.stringify(c.detail).slice(0, 3000)}`);
	}
}
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${checks.length} checks passed`);
process.exitCode = failed ? 1 : 0;
