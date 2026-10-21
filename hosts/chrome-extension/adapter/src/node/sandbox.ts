import { FixtureError, SandboxCallError, verifyBuild, type Build, type Sandbox, type Spec, type Surface, type Verification } from '@swissspidy/graft-core';
import { startTasklet, type TaskletServer, type TaskletVersion } from '../../../fixtures/tasklet/server.ts';
import { createCan, usableScopes } from '../host/can.ts';
import { CallError, perform, viewerRole, type Fetch } from '../host/http.ts';
import { appModel } from '../host/surface.ts';
import '../host/a2ui.ts';

/**
 * The verification sandbox of the browser host: a copy of the app, never
 * the app itself and never anyone's account. A copy is anything that
 * serves the app's pages and API and also speaks the fixture protocol
 * (`/__fixture/reset`, `seed`, `instances`, `assert`): for the prototype,
 * the Tasklet fixture server; for a real app, a contract fake kept honest
 * by comparing its fingerprint with the live app's (drift.ts).
 *
 * Capability calls go through the same HTTP bindings and output
 * projection as the extension's gateway, as fixture users signed in to the
 * copy.
 */

export interface FixtureSandbox extends Sandbox {
	url: string;
	close(): Promise<void>;
}

/** A sandbox on a running copy of the app at `url`. */
export function connectSandbox(url: string, initial?: Surface): FixtureSandbox {
	let surface = initial;
	const sessions = new Map<string, string>();
	const control = async <T>(path: string, body?: unknown): Promise<T> => {
		const response = await fetch(`${url}/__fixture/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		const data = (await response.json()) as T & { error?: string };
		if (!response.ok) {
			throw new FixtureError(data.error ?? `The sandbox answered ${response.status}.`);
		}
		return data;
	};
	const sessionFetch = async (user: string): Promise<Fetch> => {
		let cookie = sessions.get(user);
		if (!cookie) {
			const response = await fetch(`${url}/login?as=${encodeURIComponent(user)}`, { redirect: 'manual' });
			cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
			if (!cookie) {
				throw new SandboxCallError('sandbox_no_user', `The sandbox has no user "${user}".`);
			}
			sessions.set(user, cookie);
		}
		const session = cookie;
		return (target, init) => fetch(target, { ...init, headers: { ...(init.headers as Record<string, string>), cookie: session } });
	};
	const current = () => {
		if (!surface) {
			throw new Error('The sandbox was not prepared with a surface.');
		}
		return surface;
	};
	return {
		url,
		async prepare(next) {
			surface = next;
		},
		async reset() {
			sessions.clear();
			await control('reset', {});
		},
		async seed(fixtures) {
			const { users } = await control<{ users: Record<string, string[]> }>('seed', fixtures);
			return { users };
		},
		async scopes(user, scopes) {
			const role = await viewerRole(appModel(current()).viewer, url, await sessionFetch(user));
			return usableScopes(current(), role, scopes, scopes);
		},
		async call(user, capability, input) {
			const declared = current().capabilities[capability];
			if (!declared) {
				throw new SandboxCallError('graft_unknown_capability', `The app has no "${capability}".`);
			}
			try {
				return await perform(declared, input ?? {}, url, await sessionFetch(user));
			} catch (error) {
				throw error instanceof CallError ? new SandboxCallError(error.code, error.message) : error;
			}
		},
		async slotInstances(_user, slot) {
			return (await control<{ instances: Array<Record<string, unknown>> }>(`instances?slot=${encodeURIComponent(slot)}`)).instances;
		},
		async assert(kind, expected) {
			return control<{ ok: boolean; actual: unknown }>('assert', { kind, expected });
		},
		close: async () => {},
	};
}

export interface TaskletSandbox extends FixtureSandbox {
	server: TaskletServer;
	setVersion(version: TaskletVersion): void;
}

/** A sandbox on a fresh, empty Tasklet fixture server of a version. */
export async function startTaskletSandbox(options: { version?: TaskletVersion } = {}): Promise<TaskletSandbox> {
	const server = await startTasklet({ seed: 'empty', ...(options.version ? { version: options.version } : {}) });
	const sandbox = connectSandbox(server.url);
	return { ...sandbox, server, setVersion: (version) => server.setVersion(version), close: () => server.close() };
}

export interface VerifyTarget {
	build: Build;
	spec: Spec;
	surface: Surface;
}

/** Verifies builds in one sandbox; starts a Tasklet one unless given. */
export async function verifyInBrowserHost(targets: VerifyTarget[], options: { sandbox?: FixtureSandbox; grant?: string[] } = {}): Promise<Verification[]> {
	const sandbox = options.sandbox ?? (await startTaskletSandbox());
	try {
		const results: Verification[] = [];
		for (const target of targets) {
			results.push(await verifyBuild({ ...target, sandbox, createCan, ...(options.grant ? { grant: options.grant } : {}) }));
		}
		return results;
	} finally {
		if (!options.sandbox) {
			await sandbox.close();
		}
	}
}
