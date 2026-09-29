import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxCallError, type Sandbox } from '@graft/core';
import { DEFAULT_PHP, PLAYGROUND_CLI, paths } from './playground.ts';

export interface WordPressSandbox extends Sandbox {
	/** The WordPress version the sandbox runs. */
	readonly url: string;
	close(): Promise<void>;
}

export interface SandboxOptions {
	wp?: string;
	php?: string;
	/** Log Playground output. */
	verbose?: boolean;
}

const sandboxDir = fileURLToPath(new URL('../../playground/sandbox', import.meta.url));

/**
 * Boots a throwaway WordPress in Playground with the Graft plugin and the
 * sandbox endpoint, for the verifier. Nothing in it is tenant data; every
 * check resets it and seeds its own fixtures.
 */
export async function startSandbox({ wp = '7.1', php = DEFAULT_PHP, verbose = false }: SandboxOptions = {}): Promise<WordPressSandbox> {
	const port = await freePort();
	const token = randomBytes(24).toString('hex');
	const dir = await mkdtemp(join(tmpdir(), 'graft-sandbox-'));
	const blueprint = join(dir, 'blueprint.json');
	await writeFile(
		blueprint,
		JSON.stringify({
			preferredVersions: { php, wp },
			steps: [
				{ step: 'defineWpConfigConsts', consts: { GRAFT_SANDBOX_TOKEN: token } },
				{ step: 'activatePlugin', pluginPath: 'graft/graft.php' },
			],
		}),
	);
	const child = spawn(
		'npx',
		[
			'--yes',
			PLAYGROUND_CLI,
			'server',
			`--port=${port}`,
			`--wp=${wp}`,
			`--php=${php}`,
			'--workers=1',
			`--mount=${paths.plugin}:/wordpress/wp-content/plugins/graft`,
			`--mount=${sandboxDir}:/wordpress/graft-sandbox`,
			`--blueprint=${blueprint}`,
		],
		{ stdio: verbose ? 'inherit' : 'ignore', detached: true },
	);
	const url = `http://127.0.0.1:${port}/graft-sandbox/`;

	const op = async <T>(body: Record<string, unknown>): Promise<T> => {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Graft-Sandbox': token },
			body: JSON.stringify(body),
		});
		const text = await response.text();
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			throw new Error(`Sandbox answered ${body.op} with non-JSON (${response.status}): ${text.slice(0, 500)}`);
		}
		if (!response.ok) {
			throw new Error(`Sandbox ${body.op} failed (${response.status}): ${JSON.stringify(data)}`);
		}
		return data as T;
	};

	const close = async () => {
		stop(child);
		await rm(dir, { recursive: true, force: true });
	};

	try {
		await waitUntil(async () => (await op<{ ok?: boolean }>({})).ok === true, 240_000, child);
	} catch (error) {
		await close();
		throw error;
	}

	return {
		url,
		close,
		async reset() {
			await op({ op: 'reset' });
		},
		async seed(fixtures) {
			const { users } = await op<{ users: Record<string, string[]> }>({ op: 'seed', fixtures });
			return { users };
		},
		async scopes(user, scopes) {
			return (await op<{ scopes: Record<string, boolean> }>({ op: 'scopes', as: user, scopes })).scopes;
		},
		async call(user, capability, input) {
			const data = await op<{ result?: unknown; error?: { code: string; message: string } }>({ op: 'call', as: user, capability, input });
			if (data.error) {
				throw new SandboxCallError(data.error.code, data.error.message);
			}
			return data.result;
		},
		async slotInstances(user, slot) {
			return (await op<{ instances: Array<Record<string, unknown>> }>({ op: 'slot', as: user, slot })).instances;
		},
		async assert(kind, expected) {
			return op<{ ok: boolean; actual: unknown }>({ op: 'assert', kind, expected });
		},
	};
}

function stop(child: ChildProcess): void {
	if (child.pid !== undefined && child.exitCode === null) {
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch {
			child.kill('SIGTERM');
		}
	}
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No port'))));
		});
	});
}

async function waitUntil(ready: () => Promise<boolean>, timeout: number, child: ChildProcess): Promise<void> {
	const start = Date.now();
	let last: unknown;
	while (Date.now() - start < timeout) {
		if (child.exitCode !== null) {
			throw new Error(`Playground exited with ${child.exitCode} before the sandbox was ready.`);
		}
		try {
			if (await ready()) {
				return;
			}
		} catch (error) {
			last = error;
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`The sandbox did not start within ${timeout / 1000}s: ${last instanceof Error ? last.message : String(last)}`);
}
