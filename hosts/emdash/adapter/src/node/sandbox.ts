import { SandboxCallError, verifyBuild, type Build, type Sandbox, type Spec, type Surface, type Verification } from '@graft/core';
import { loadFunctions } from '@graft/sandbox';
import { createCan } from '../host/can.ts';
import type { HostPatch } from '../host/patch.ts';
import { semantics } from '../host/semantics.ts';
import { pluginRoute, startEmDash, type EmDashServer, type StartOptions } from './server.ts';

/**
 * The verification sandbox: a throwaway EmDash with the Graft sandbox
 * route, driven over HTTP.
 */

export interface EmDashSandbox extends Sandbox {
	server: EmDashServer;
	/** The surface as the (possibly patched) sandbox reports it. */
	surface(): Promise<Surface>;
	/** Applies a synthetic host change; {} restores the real host. */
	patch(patch: HostPatch): Promise<void>;
	close(): Promise<void>;
}

export async function startSandbox(options: Omit<StartOptions, 'sandbox'> = {}): Promise<EmDashSandbox> {
	const server = await startEmDash({ ...options, sandbox: true });
	const op = <T>(body: Record<string, unknown>) => pluginRoute<T>(server, 'sandbox', body);
	return {
		server,
		async reset() {
			await op({ op: 'reset' });
		},
		async seed(fixtures) {
			return op<{ users: Record<string, string[]> }>({ op: 'seed', fixtures });
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
		async patch(patch) {
			await op({ op: 'patch', patch });
		},
		async surface() {
			return (await op<{ surface: Surface }>({ op: 'dump' })).surface;
		},
		close: () => server.close(),
	};
}

export interface VerifyTarget {
	build: Build;
	spec: Spec;
	surface: Surface;
}

/** Verifies builds in one EmDash sandbox; starts one unless given. */
export async function verifyInEmDash(targets: VerifyTarget[], options: { sandbox?: EmDashSandbox; log?: (line: string) => void } = {}): Promise<Verification[]> {
	const sandbox = options.sandbox ?? (await startSandbox({ log: options.log }));
	try {
		const results: Verification[] = [];
		for (const target of targets) {
			results.push(await verifyBuild({ ...target, sandbox, semantics, createCan, loadFunctions }));
		}
		return results;
	} finally {
		if (!options.sandbox) {
			await sandbox.close();
		}
	}
}
