import type { SurfaceFunctions } from '@graft/core';

/**
 * WordPress runs build functions in wp-admin, in QuickJS inside a Web
 * Worker (@graft/sandbox), under these limits.
 */
export const functions: SurfaceFunctions = {
	runtime: 'quickjs',
	limits: { timeMs: 50, memoryBytes: 8 * 1024 * 1024, outputBytes: 16 * 1024, sourceBytes: 32 * 1024 },
};
