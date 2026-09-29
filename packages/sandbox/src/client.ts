import type { AsyncFunctionRunner, BuildCode, FunctionCall, FunctionResult } from '@graft/core/runtime';
import type { Limits } from './index.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

/**
 * The page's side of the functions worker. Nothing is fetched until a
 * build with code asks for its first result: the worker script and the
 * QuickJS module load then, and only then.
 *
 * QuickJS stops a call at its deadline. As a second line, a watchdog
 * terminates the whole worker when a batch overruns; after `maxRestarts`
 * the build's functions stay off and every call fails.
 */

export interface StartOptions {
	/** URL of the bundled worker script. */
	workerUrl: string;
	/** URL of QuickJS's .wasm file. */
	wasmLocation?: string;
	code: BuildCode;
	limits: Limits;
	/** Time a batch may take, loading included, before the worker is terminated. Default: 2 s plus the time limit per call. */
	watchdogMs?: (calls: number) => number;
	maxRestarts?: number;
	/** Called when a call fails or the worker is terminated, for the host's log. */
	onProblem?(message: string): void;
	/** For tests: how workers are created. */
	createWorker?(url: string): Worker;
}

interface Pending {
	resolve(results: FunctionResult[]): void;
	calls: FunctionCall[];
	timer: ReturnType<typeof setTimeout>;
}

export function startFunctions(options: StartOptions): AsyncFunctionRunner {
	const watchdog = options.watchdogMs ?? ((calls: number) => 2000 + calls * options.limits.timeMs);
	const maxRestarts = options.maxRestarts ?? 2;
	const createWorker = options.createWorker ?? ((url: string) => new Worker(url, { name: 'graft-functions' }));
	let worker: Worker | undefined;
	let loaded: Promise<string | undefined> | undefined;
	let restarts = 0;
	let nextId = 1;
	let disabled: string | undefined;
	const pending = new Map<number, Pending>();

	const fail = (calls: FunctionCall[], kind: 'timeout' | 'error', message: string): FunctionResult[] => calls.map(() => ({ ok: false, kind, message }));

	function start(): Promise<string | undefined> {
		const current = createWorker(options.workerUrl);
		worker = current;
		loaded = new Promise((resolve) => {
			current.addEventListener('message', (event: MessageEvent<FromWorker>) => {
				const message = event.data;
				if (message.type === 'loaded') {
					resolve(undefined);
				} else if (message.type === 'load-failed') {
					resolve(message.message);
				} else {
					const entry = pending.get(message.id);
					if (entry) {
						pending.delete(message.id);
						clearTimeout(entry.timer);
						for (const result of message.results) {
							if (!result.ok) {
								options.onProblem?.(result.message);
							}
						}
						entry.resolve(message.results);
					}
				}
			});
			current.addEventListener('error', (event) => resolve(event.message || 'The functions worker failed to start'));
		});
		current.postMessage({ type: 'load', code: options.code, limits: options.limits, wasmLocation: options.wasmLocation } satisfies ToWorker);
		return loaded;
	}

	function terminate(reason: string): void {
		worker?.terminate();
		worker = undefined;
		loaded = undefined;
		for (const [id, entry] of pending) {
			pending.delete(id);
			clearTimeout(entry.timer);
			entry.resolve(fail(entry.calls, 'timeout', reason));
		}
		restarts += 1;
		if (restarts > maxRestarts) {
			disabled = 'The build\'s functions kept overrunning and were turned off.';
		}
		options.onProblem?.(reason);
	}

	return {
		async call(calls) {
			if (disabled) {
				return fail(calls, 'error', disabled);
			}
			const loadError = await Promise.race([
				loaded ?? start(),
				// Fetching and compiling QuickJS takes a moment; a load that hangs is stopped too.
				new Promise<string>((resolve) => setTimeout(() => resolve(`loading took longer than ${10000 + watchdog(0)} ms`), 10000 + watchdog(0))),
			]);
			if (loadError) {
				disabled = `The build's code did not load: ${loadError}`;
				options.onProblem?.(disabled);
				return fail(calls, 'error', disabled);
			}
			const id = nextId++;
			return new Promise<FunctionResult[]>((resolve) => {
				const timer = setTimeout(() => terminate(`The build's functions took longer than ${watchdog(calls.length)} ms; the worker was stopped.`), watchdog(calls.length));
				pending.set(id, { resolve, calls, timer });
				worker!.postMessage({ type: 'call', id, calls } satisfies ToWorker);
			});
		},
		dispose() {
			worker?.terminate();
			worker = undefined;
			disabled = 'Closed.';
		},
	};
}
