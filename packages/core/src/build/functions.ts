import { canonicalJson } from '../surface/hash.ts';

/**
 * Runs a build's pure functions. Hosts implement it with a sandbox
 * (@graft/sandbox): the code sees only its arguments, and gets no host API.
 * `call` throws FunctionError when a call fails or breaks a limit.
 */
export interface FunctionRunner {
	/** `now` is the time Date reports inside the call; the host's current time when omitted. */
	call(name: string, args: unknown[], now?: number): unknown;
	dispose?(): void;
}

export type FunctionErrorKind = 'timeout' | 'memory' | 'output' | 'error' | 'unknown-function';

export class FunctionError extends Error {
	constructor(
		readonly kind: FunctionErrorKind,
		message: string,
	) {
		super(message);
		this.name = 'FunctionError';
	}
}

/** Cache key for a call: results depend only on the function and its arguments. */
export const functionKey = (name: string, args: unknown[]): string => `${name}:${canonicalJson(args)}`;

/** One call to a build function, for hosts that run them off the main thread. */
export interface FunctionCall {
	name: string;
	args: unknown[];
	/** The time Date reports inside the call. */
	now?: number;
}

export type FunctionResult = { ok: true; value: unknown } | { ok: false; kind: FunctionErrorKind; message: string };

/** Runs build functions asynchronously, in batches (a Web Worker, say). */
export interface AsyncFunctionRunner {
	call(calls: FunctionCall[]): Promise<FunctionResult[]>;
	dispose?(): void;
}
