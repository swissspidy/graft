import { SandboxCallError, type Sandbox } from '@swissspidy/graft-core';
import type { HostDump } from './surface-types.ts';

/**
 * The verification sandbox protocol (playground/sandbox/index.php), over
 * any transport: HTTP to a Playground server from Node, or
 * `client.request()` to Playground in a browser iframe.
 */
export type SandboxTransport = (body: Record<string, unknown>) => Promise<unknown>;

export interface ProtocolSandbox extends Sandbox {
	/** Applies a synthetic host change (see playground/sandbox/canary.php). */
	patch(patch: Record<string, unknown>): Promise<void>;
	/** The host half of the surface as the sandbox currently exposes it. */
	dump(): Promise<HostDump>;
}

export function protocolSandbox(send: SandboxTransport): ProtocolSandbox {
	const op = async <T>(body: Record<string, unknown>) => (await send(body)) as T;
	return {
		async prepare(surface) {
			await op({ op: 'model', model: surface.model ?? null });
		},
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
		async slotInstances(user, slot, options = {}) {
			return (await op<{ instances: Array<Record<string, unknown>> }>({ op: 'slot', as: user, slot, options })).instances;
		},
		async assert(kind, expected) {
			return op<{ ok: boolean; actual: unknown }>({ op: 'assert', kind, expected });
		},
		async patch(patch) {
			await op({ op: 'patch', patch });
		},
		async dump() {
			return op<HostDump>({ op: 'dump' });
		},
	};
}
