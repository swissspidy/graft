import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
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
	/** Extra environment for the site. */
	env?: Record<string, string>;
	/** How EmDash runs the plugin: in-process (default) or in its plugin sandbox. */
	format?: 'native' | 'sandboxed';
	/** Hosts the plugin may call besides api.anthropic.com. */
	allowedHosts?: string[];
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

async function portInUse(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ port, host: '127.0.0.1' });
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('error', () => resolve(false));
	});
}

export async function startEmDash(options: StartOptions = {}): Promise<EmDashServer> {
	if (options.format === 'sandboxed' && options.sandbox) {
		throw new Error('The verification sandbox route is native only.');
	}
	const port = options.port ?? 4460 + Math.floor(Math.random() * 400);
	// Astro would move to another port; a stale server would answer instead.
	if (await portInUse(port)) {
		throw new Error(`Port ${port} is in use.`);
	}
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
			GRAFT_FORMAT: options.format ?? 'native',
			// A fixed test key: plugin settings with secrets need one.
			EMDASH_ENCRYPTION_KEY: 'emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
			GRAFT_ALLOWED_HOSTS: (options.allowedHosts ?? []).join(','),
			ASTRO_TELEMETRY_DISABLED: '1',
			...options.env,
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
		// The dev server can still be settling when it first answers (Vite optimizing
		// dependencies): setup then fails with a 500, or the connection drops. Setup is
		// idempotent, so both are retried; a 4xx is an answer and is not.
		let setup: Response;
		let body: { data?: { token?: string } };
		for (let attempt = 1; ; attempt++) {
			try {
				setup = await fetch(`${url}/_emdash/api/setup/dev-bypass?token=1${options.content ? '' : '&content=0'}`, {
					method: 'POST',
					headers: { 'X-EmDash-Request': '1' },
				});
				body = (await setup.json().catch(() => ({}))) as { data?: { token?: string } };
				if (setup.status < 500 || attempt === 5) {
					break;
				}
			} catch (error) {
				if (attempt === 5) {
					throw new Error(`EmDash setup failed: ${error instanceof Error ? error.message : String(error)}\n${output.slice(-4000)}`);
				}
			}
			await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
		}
		const token = body.data?.token;
		if (!setup.ok || !token) {
			throw new Error(`EmDash setup failed (${setup.status}): ${JSON.stringify(body)}\n${output.slice(-4000)}`);
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

/** EmDash's content REST API as the dev admin: seeding and checking a site without the sandbox route. */
export function contentApi(server: Pick<EmDashServer, 'url' | 'token'>) {
	const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
		const response = await fetch(`${server.url}/_emdash/api/content/${path}`, {
			method,
			headers: { Authorization: `Bearer ${server.token}`, 'X-EmDash-Request': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
		const json = (await response.json().catch(() => ({}))) as { data?: T; error?: { message?: string } };
		if (!response.ok) {
			throw new Error(`${method} ${path}: ${response.status} ${json.error?.message ?? ''}`);
		}
		return json.data as T;
	};
	type Item = { id: string; status: string; data: { title?: string } };
	const list = async (collection = 'posts') => (await call<{ items: Item[] }>('GET', `${collection}?limit=100`)).items;
	return {
		list,
		async find(title: string, collection = 'posts') {
			return (await list(collection)).find((item) => item.data.title === title);
		},
		/** Creates entries oldest first; status draft, published or scheduled. */
		async seed(entries: Array<{ title: string; status?: string; collection?: string }>) {
			for (const entry of entries) {
				const collection = entry.collection ?? 'posts';
				const created = await call<{ item: Item }>('POST', collection, { data: { title: entry.title } });
				const status = entry.status ?? 'published';
				if (status === 'published') {
					await call('POST', `${collection}/${created.item.id}/publish`, {});
				} else if (status === 'scheduled') {
					await call('POST', `${collection}/${created.item.id}/schedule`, { scheduledAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString() });
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		},
		async clear(collection = 'posts') {
			for (const item of await list(collection)) {
				await call('DELETE', `${collection}/${item.id}`);
			}
		},
	};
}
