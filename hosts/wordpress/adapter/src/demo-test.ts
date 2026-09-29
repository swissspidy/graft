import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { chromium } from '@playwright/test';
import { DEFAULT_PHP, PLAYGROUND_CLI } from './playground.ts';

/**
 * Builds the Playground demo, serves it locally, boots WordPress from its
 * blueprint the way playground.wordpress.net would (installing the plugin
 * from the zip, seeding, logging in), and checks the customizations appear
 * in wp-admin. Run `pnpm build` first.
 */

const files = 9500;
const site = 9401;
const out = await mkdtemp(join(tmpdir(), 'graft-demo-'));
const base = `http://127.0.0.1:${files}/`;

await run('npx', ['tsx', new URL('./demo.ts', import.meta.url).pathname, '--out', out, '--base-url', base]);

const types: Record<string, string> = { '.json': 'application/json', '.zip': 'application/zip', '.php': 'text/plain', '.html': 'text/html' };
const server = createServer(async (req, res) => {
	try {
		const body = await readFile(join(out, (req.url ?? '/').replace(/^\//, '').replace(/\.\./g, '')));
		res.setHeader('content-type', types[extname(req.url ?? '')] ?? 'application/octet-stream');
		res.setHeader('access-control-allow-origin', '*');
		res.end(body);
	} catch {
		res.statusCode = 404;
		res.end();
	}
}).listen(files);

// The CLI does not apply the blueprint's preferredVersions; the web Playground does.
const playground = spawn('npx', ['--yes', PLAYGROUND_CLI, 'server', `--port=${site}`, '--wp=7.1', `--php=${DEFAULT_PHP}`, `--blueprint=${join(out, 'blueprint.json')}`], { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
const failures: string[] = [];
try {
	await new Promise<void>((resolve, reject) => {
		playground.stdout.on('data', (chunk: Buffer) => {
			process.stdout.write(chunk);
			if (chunk.toString().includes('Ready!')) {
				resolve();
			}
		});
		playground.on('exit', (code) => reject(new Error(`Playground exited with ${code}`)));
	});

	const browser = await chromium.launch();
	const page = await browser.newPage();
	const login = async (user: string) => {
		await page.context().clearCookies();
		await page.goto(`http://127.0.0.1:${site}/wp-login.php`);
		await page.fill('#user_login', user);
		await page.fill('#user_pass', 'password');
		await page.click('#wp-submit');
		await page.waitForURL(/wp-admin/);
	};
	await login('admin');
	await page.goto(`http://127.0.0.1:${site}/wp-admin/index.php`);

	const check = async (what: string, run: () => Promise<unknown>) => {
		try {
			await run();
			console.log(`✔ ${what}`);
		} catch (error) {
			failures.push(what);
			console.log(`✖ ${what}: ${(error as Error).message.split('\n')[0]}`);
		}
	};
	const widget = (id: string) => page.locator(`#graft-${id}`);
	await check('the headline check flags a shouting headline', () =>
		widget('headline-check').locator('tbody tr', { hasText: 'BUDGET SHOWDOWN TONIGHT' }).getByText('All caps').waitFor({ timeout: 30_000 }),
	);
	await check('stale drafts shows a draft untouched for 45 days', () => widget('stale-drafts').getByText('45', { exact: true }).waitFor({ timeout: 30_000 }));
	await check('pending by author filters by author', async () => {
		await widget('pending-by-author').locator('[data-graft-action="author-grace-hopper"]').click({ timeout: 30_000 });
		// The widget redraws once its update has run: wait for Ada's post to go.
		await widget('pending-by-author').locator('tbody tr', { hasText: 'BUDGET SHOWDOWN' }).waitFor({ state: 'detached', timeout: 30_000 });
		await widget('pending-by-author').locator('tbody tr', { hasText: 'Library hours' }).waitFor();
	});
	await page.goto(`http://127.0.0.1:${site}/wp-admin/tools.php?page=graft-customizations`);
	await check('waiting-posts waits for approval', () => page.locator('[data-graft-spec="waiting-posts"] [data-graft-state]', { hasText: 'Needs approval' }).waitFor({ timeout: 30_000 }));
	// The review queue is for editors and contributors.
	await login('edna');
	await page.goto(`http://127.0.0.1:${site}/wp-admin/admin.php?page=graft-review-queue`);
	await check('the review queue lists pending posts for the editor', () => page.locator('.graft-page table tbody tr', { hasText: 'Library hours' }).waitFor({ timeout: 30_000 }));
	await page.screenshot({ path: 'test-results/demo-review-queue.png' });
	await browser.close();
} finally {
	// npx starts the server as a child: stop the whole group.
	try {
		process.kill(-playground.pid!, 'SIGTERM');
	} catch {
		// Already gone.
	}
	server.close();
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nThe demo works.');
process.exit(failures.length ? 1 : 0);

function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: 'inherit' });
		child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
	});
}
