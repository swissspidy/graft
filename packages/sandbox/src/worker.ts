/// <reference lib="webworker" />
import { FunctionError, type FunctionResult } from '@graft/core/runtime';
import { loadFunctions, type QuickJSFunctions } from './index.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

/**
 * The functions worker: one per build with code. The build's code runs in
 * QuickJS inside it, so it is two boundaries away from the page: the
 * WebAssembly realm, then the worker (no DOM, killable by the page).
 */

declare const self: DedicatedWorkerGlobalScope;

let functions: QuickJSFunctions | undefined;

const post = (message: FromWorker) => self.postMessage(message);

/**
 * Once QuickJS is instantiated the worker needs no network or storage, so
 * it drops them: even a flaw in the sandbox would find nothing to use.
 */
function lockDown(): void {
	for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'cookieStore']) {
		try {
			Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false });
		} catch {
			// Not present here.
		}
	}
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
	const message = event.data;
	if (message.type === 'load') {
		try {
			functions = await loadFunctions(message.code, message.limits, { wasmLocation: message.wasmLocation });
			lockDown();
			post({ type: 'loaded' });
		} catch (error) {
			post({ type: 'load-failed', message: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	const results = message.calls.map(({ name, args }): FunctionResult => {
		if (!functions) {
			return { ok: false, kind: 'error', message: 'The code is not loaded' };
		}
		try {
			return { ok: true, value: functions.call(name, args) };
		} catch (error) {
			return error instanceof FunctionError ? { ok: false, kind: error.kind, message: error.message } : { ok: false, kind: 'error', message: String(error) };
		}
	});
	post({ type: 'results', id: message.id, results });
};
