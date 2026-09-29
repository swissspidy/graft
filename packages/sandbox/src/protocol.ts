import type { BuildCode, FunctionCall, FunctionResult } from '@graft/core/runtime';
import type { Limits } from './index.ts';

/** Messages between the page and the functions worker. */
export type ToWorker =
	| { type: 'load'; code: BuildCode; limits: Limits; wasmLocation?: string }
	| { type: 'call'; id: number; calls: FunctionCall[] };

export type FromWorker = { type: 'loaded' } | { type: 'load-failed'; message: string } | { type: 'results'; id: number; results: FunctionResult[] };
