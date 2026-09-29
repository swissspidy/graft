import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Starts the EmDash test site (hosts/emdash/site) with `astro dev` on a
 * fresh SQLite database, runs EmDash's dev setup and returns an admin
 * token. `sandbox` enables the Graft verification sandbox route.
 */

export const SITE_DIR = fileURLToPath(new URL('../../../site/', import.meta.url));

export interface EmDashServer {
	url: string;
	/** An admin personal access token (Bearer). */
	token: string;
	/** Session cookie of the dev admin, for browsers. */
	cookie: string;
	database: string;
	close(): Promise<void>;
}

export interface StartOptions {
	port?: number;
	sandbox?: boolean;
	/** Keep the database here instead of a temporary directory. */
	database?: string;
	log?: (line: string) => void;
	/** Seed the site's sample content (default: no content). */
	content?: boolean;
	/** Enables /graft-test/login, which signs in test users with any role. */
	testLogin?: boolean;
}

async function waitFor(url: string, child: ChildProcess, output: () => string, timeoutMs = 180_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (child.exitCode !== null) {
			throw new Error(`EmDash exited (${child.exitCode}):\n${output()}`);
		}
		try {
			const response = await fetch(url);
			if (response.status < 500) {
				return;
			}
		} catch {
			// not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`EmDash did not start within ${timeoutMs / 1000}s:\n${output()}`);
}

export async function startEmDash(options: StartOptions = {}): Promise<EmDashServer> {
	const port = options.port ?? 4460 + Math.floor(Math.random() * 400);
	const dir = options.database ? undefined : await mkdtemp(join(tmpdir(), 'graft-emdash-'));
	const database = options.database ?? join(dir!, 'site.db');
	let output = '';
	const child = spawn('pnpm', ['exec', 'astro', 'dev', '--port', String(port), '--host', '127.0.0.1', '--ignore-lock'], {
		cwd: SITE_DIR,
		env: {
			...process.env,
			EMDASH_TEST_DB: `file:${database}`,
			GRAFT_SANDBOX: options.sandbox ? '1' : '',
			GRAFT_TEST_LOGIN: options.testLogin ? '1' : '',
			ASTRO_TELEMETRY_DISABLED: '1',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: process.platform !== 'win32',
	});
	const collect = (chunk: Buffer) => {
		const text = chunk.toString();
		output = (output + text).slice(-20_000);
		options.log?.(text);
	};
	child.stdout!.on('data', collect);
	child.stderr!.on('data', collect);

	const url = `http://127.0.0.1:${port}`;
	const close = async () => {
		if (child.exitCode === null) {
			try {
				process.kill(-child.pid!, 'SIGTERM');
			} catch {
				child.kill('SIGTERM');
			}
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, 5000);
				child.once('exit', () => {
					clearTimeout(timer);
					resolve(undefined);
				});
			});
		}
		if (dir) {
			await rm(dir, { recursive: true, force: true });
		}
	};

	try {
		await waitFor(`${url}/`, child, () => output);
		const setup = await fetch(`${url}/_emdash/api/setup/dev-bypass?token=1${options.content ? '' : '&content=0'}`, {
			method: 'POST',
			headers: { 'X-EmDash-Request': '1' },
		});
		const body = (await setup.json()) as { data?: { token?: string } };
		const token = body.data?.token;
		if (!setup.ok || !token) {
			throw new Error(`EmDash setup failed (${setup.status}): ${JSON.stringify(body)}`);
		}
		const cookie = (setup.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
		return { url, token, cookie, database, close };
	} catch (error) {
		await close();
		throw error;
	}
}

/** Signs a test user in (see site/src/pages/graft-test/login.ts); returns their session cookie. */
export async function login(server: Pick<EmDashServer, 'url'>, user: string, role: number): Promise<{ id: string; cookie: string }> {
	const response = await fetch(`${server.url}/graft-test/login?user=${user}&role=${role}`);
	if (!response.ok) {
		throw new Error(`Login as ${user} failed: ${response.status}`);
	}
	const { id } = (await response.json()) as { id: string };
	return { id, cookie: (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') };
}

/** POSTs JSON to an EmDash API path with a session cookie, as the admin UI does. */
export async function asUser<T>(server: Pick<EmDashServer, 'url'>, cookie: string, path: string, body: unknown): Promise<{ status: number; data?: T; error?: { code?: string; message?: string } }> {
	const response = await fetch(`${server.url}${path}`, {
		method: 'POST',
		headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-EmDash-Request': '1', Origin: server.url },
		body: JSON.stringify(body),
	});
	const json = (await response.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string } };
	return { status: response.status, ...json };
}

/** Calls a Graft plugin route as the dev admin. */
export async function pluginRoute<T>(server: Pick<EmDashServer, 'url' | 'token'>, route: string, body: unknown = {}): Promise<T> {
	const response = await fetch(`${server.url}/_emdash/api/plugins/graft/${route}`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json', 'X-EmDash-Request': '1' },
		body: JSON.stringify(body),
	});
	const json = (await response.json().catch(() => ({}))) as { data?: T; error?: { message?: string; details?: unknown } };
	if (!response.ok) {
		const details = json.error?.details ? ` ${JSON.stringify(json.error.details)}` : '';
		throw new Error(`${route}: ${response.status} ${json.error?.message ?? JSON.stringify(json)}${details}`);
	}
	return json.data as T;
}
