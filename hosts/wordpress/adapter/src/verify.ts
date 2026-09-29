import { verifyBuild, type Build, type Spec, type Surface, type Verification } from '@graft/core';
import { createCan } from './can.ts';
import { startSandbox, type SandboxOptions, type WordPressSandbox } from './sandbox.ts';
import { semantics } from './semantics.ts';
import { loadFunctions } from '@graft/sandbox';

export interface VerifyTarget {
	build: Build;
	spec: Spec;
	surface: Surface;
}

/**
 * Verifies builds in one WordPress sandbox. Starts the sandbox unless one
 * is passed in, and closes what it started.
 */
export async function verifyInWordPress(
	targets: VerifyTarget[],
	options: SandboxOptions & { sandbox?: WordPressSandbox } = {},
): Promise<Verification[]> {
	const sandbox = options.sandbox ?? (await startSandbox(options));
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
