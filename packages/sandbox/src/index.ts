import releaseSyncModule from '@jitl/quickjs-wasmfile-release-sync';
import type { QuickJSSyncVariant } from 'quickjs-emscripten-core';
import type { BuildCode } from '@graft/core/runtime';
import { QuickJSFunctions, type Limits } from './runner.ts';

/**
 * Build functions in QuickJS compiled to WebAssembly: for Node and
 * browsers. Runtimes that compile no WebAssembly at run time (Cloudflare's)
 * use `@graft/sandbox/asmjs` instead.
 */

export { QuickJSFunctions, type Limits } from './runner.ts';

// Typed as a CommonJS namespace; at runtime the default export is the variant.
const releaseSync = releaseSyncModule as unknown as QuickJSSyncVariant;

/** Starts a sandbox for a build's code. Matches VerifyOptions.loadFunctions. */
export function loadFunctions(code: BuildCode, limits: Limits, options: { wasmLocation?: string } = {}): Promise<QuickJSFunctions> {
	return QuickJSFunctions.load(code, limits, { ...options, variant: releaseSync });
}

/** The limits WordPress declares in its surface. */
export const DEFAULT_LIMITS: Limits = { timeMs: 50, memoryBytes: 8 * 1024 * 1024, outputBytes: 16 * 1024, sourceBytes: 32 * 1024 };
