import type { Build, HostGuide, Sandbox, Spec, Surface, Verification } from '@graft/core';

/**
 * The host adapters the CLI can drive: a compiler guide, a verification
 * sandbox and the verifier wired to the host's semantics. Loaded lazily so
 * one host's tooling is only loaded when a surface needs it.
 */
export interface HostTools {
	guide: HostGuide;
	startSandbox(): Promise<Sandbox & { close(): Promise<void> }>;
	verify(targets: Array<{ build: Build; spec: Spec; surface: Surface }>, sandbox?: Sandbox & { close(): Promise<void> }): Promise<Verification[]>;
}

export interface HostToolOptions {
	/** WordPress version for the Playground sandbox. */
	wp?: string;
	verbose?: boolean;
}

export async function hostTools(surface: Surface, options: HostToolOptions = {}): Promise<HostTools> {
	if (surface.host === 'wordpress') {
		const wordpress = await import('@graft/wordpress-adapter');
		const wp = options.wp ?? wordpress.playgroundVersion(surface.hostVersion);
		return {
			guide: wordpress.hostGuide,
			startSandbox: () => wordpress.startSandbox({ wp, verbose: options.verbose ?? false }),
			verify: (targets, sandbox) => wordpress.verifyInWordPress(targets, { wp, verbose: options.verbose ?? false, ...(sandbox ? { sandbox: sandbox as never } : {}) }),
		};
	}
	if (surface.host === 'emdash') {
		const emdash = await import('@graft/emdash/node');
		const log = options.verbose ? (line: string) => process.stderr.write(line) : undefined;
		return {
			guide: emdash.hostGuide,
			startSandbox: () => emdash.startSandbox(log ? { log } : {}),
			verify: (targets, sandbox) => emdash.verifyInEmDash(targets, { ...(sandbox ? { sandbox: sandbox as never } : {}), ...(log ? { log } : {}) }),
		};
	}
	throw new Error(`No host adapter for "${surface.host}".`);
}
