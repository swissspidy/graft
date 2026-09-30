import asmjsModule from '@jitl/quickjs-asmjs-mjs-release-sync';
import type { QuickJSSyncVariant } from 'quickjs-emscripten-core';
import type { BuildCode } from '@graft/core/runtime';
import { QuickJSFunctions, type Limits } from './runner.ts';

/**
 * Build functions in QuickJS compiled to asm.js: plain JavaScript, for
 * runtimes that compile no WebAssembly at run time (EmDash's plugin sandbox
 * on workerd and Cloudflare). Same engine and limits as the WebAssembly
 * build, slower and larger (about 1 MB).
 */

export { QuickJSFunctions, type Limits } from './runner.ts';

const asmjs = asmjsModule as unknown as QuickJSSyncVariant;

/** Starts a sandbox for a build's code. Matches VerifyOptions.loadFunctions. */
export function loadFunctions(code: BuildCode, limits: Limits): Promise<QuickJSFunctions> {
	return QuickJSFunctions.load(code, limits, { variant: asmjs });
}
