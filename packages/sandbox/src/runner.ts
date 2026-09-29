import { DefaultIntrinsics, newQuickJSWASMModuleFromVariant, newVariant, type QuickJSSyncVariant, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import { FunctionError, type BuildCode, type FunctionRunner, type SurfaceFunctions } from '@graft/core/runtime';

/**
 * Runs a build's pure functions in QuickJS compiled to WebAssembly.
 *
 * The code gets a bare ECMAScript realm: no window, document, fetch,
 * storage, cookies, timers or promises, and no way to call back into
 * the host. Arguments go in and results come out as JSON text, so no host
 * object ever crosses. Every call runs under a deadline (an infinite loop
 * is interrupted), the whole realm under a memory limit, and results are
 * capped in size.
 */

export type Limits = SurfaceFunctions['limits'];

export interface LoadOptions {
	/** The QuickJS build: WebAssembly (`index.ts`) or asm.js (`asmjs.ts`) for runtimes that compile no wasm. */
	variant: QuickJSSyncVariant;
	/** Where the QuickJS .wasm file is, when it is not next to the variant's module (browsers, bundles). */
	wasmLocation?: string;
}

const modules = new Map<QuickJSSyncVariant, Map<string, Promise<QuickJSWASMModule>>>();

function quickjs(options: LoadOptions): Promise<QuickJSWASMModule> {
	const byLocation = modules.get(options.variant) ?? new Map<string, Promise<QuickJSWASMModule>>();
	modules.set(options.variant, byLocation);
	const key = options.wasmLocation ?? '';
	let module = byLocation.get(key);
	if (!module) {
		module = newQuickJSWASMModuleFromVariant(options.wasmLocation ? newVariant(options.variant, { wasmLocation: options.wasmLocation }) : options.variant);
		byLocation.set(key, module);
	}
	return module;
}

/**
 * No promises: functions are synchronous. (Eval stays: loading the code
 * needs it, and eval inside the realm reaches nothing the code can't.)
 */
const intrinsics = { ...DefaultIntrinsics, Promise: false };

/**
 * Calls `fn(...args)` with the arguments as JSON text and returns the
 * result as JSON text. Defined before the build's code runs, so the code
 * cannot replace the JSON functions it uses.
 */
const CALLER = `(() => {
	const parse = JSON.parse, stringify = JSON.stringify, apply = Reflect.apply;
	// Time and randomness are the host's, per call, so a function returns the
	// same for the same arguments at the same time (the verifier's clock).
	const RealDate = Date;
	let now = 0;
	let seed = 1;
	function FrozenDate(...args) {
		if (!new.target) {
			return new RealDate(now).toString();
		}
		return args.length ? new RealDate(...args) : new RealDate(now);
	}
	FrozenDate.prototype = RealDate.prototype;
	FrozenDate.now = () => now;
	FrozenDate.parse = RealDate.parse;
	FrozenDate.UTC = RealDate.UTC;
	Object.defineProperty(RealDate.prototype, 'constructor', { value: FrozenDate });
	globalThis.Date = FrozenDate;
	Math.random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 4294967296;
	};
	return (fn, json, time) => {
		now = time;
		seed = 1;
		const result = stringify(apply(fn, undefined, parse(json)));
		return result === undefined ? 'null' : result;
	};
})()`;

/** How long preparing the sandbox (our code, not the build's) may take. */
const SETUP_MS = 1000;

/** Exercises the parser, JSON and common built-ins once, so the build's first call finds a warm engine. */
const WARM_UP = `(() => {
	const rows = JSON.parse('[{"id":1,"title":"A b","tags":["x"]},{"id":2,"title":"C","tags":[]}]');
	const out = rows.filter((row) => row.id > 0).map((row) => ({ ...row, words: row.title.toLowerCase().split(/\\s+/).length }));
	out.sort((a, b) => a.title.localeCompare(b.title));
	return JSON.stringify(out).length + new Date(0).getTime();
})()`;

export class QuickJSFunctions implements FunctionRunner {
	#deadline = 0;
	#disposed = false;
	readonly #functions = new Map<string, QuickJSHandle>();
	readonly #caller: QuickJSHandle;

	private constructor(
		readonly limits: Limits,
		private readonly runtime: QuickJSRuntime,
		private readonly vm: QuickJSContext,
		code: BuildCode,
	) {
		runtime.setMemoryLimit(limits.memoryBytes);
		runtime.setMaxStackSize(256 * 1024);
		runtime.setInterruptHandler(() => performance.now() > this.#deadline);

		// Our own code, under a budget of its own: a cold engine (asm.js above all) is much slower
		// on its first run, and that must not count against the build's code.
		this.#caller = this.#run(() => vm.evalCode(CALLER, 'graft:caller'), 'Preparing the sandbox', SETUP_MS);
		try {
			this.#run(() => vm.evalCode(WARM_UP, 'graft:warm-up'), 'Preparing the sandbox', SETUP_MS).dispose();
			const warm = this.#run(() => vm.evalCode('(() => [1, "a", { b: true }])', 'graft:warm-up'), 'Preparing the sandbox', SETUP_MS);
			const json = vm.newString('[]');
			const time = vm.newNumber(0);
			try {
				this.#run(() => vm.callFunction(this.#caller, vm.undefined, warm, json, time), 'Preparing the sandbox', SETUP_MS).dispose();
			} finally {
				warm.dispose();
				json.dispose();
				time.dispose();
			}

			this.#run(() => vm.evalCode(code.source, 'build.js'), 'Loading the code').dispose();
			for (const name of code.functions) {
				const handle = this.#run(() => ({ value: vm.getProp(vm.global, name) }) as ReturnType<QuickJSContext['evalCode']>, `Reading "${name}"`);
				if (vm.typeof(handle) !== 'function') {
					handle.dispose();
					throw new FunctionError('unknown-function', `The code does not define a function "${name}"`);
				}
				this.#functions.set(name, handle);
			}
		} catch (error) {
			// Every handle must go before the realm does.
			this.dispose();
			throw error;
		}
	}

	static async load(code: BuildCode, limits: Limits, options: LoadOptions): Promise<QuickJSFunctions> {
		const module = await quickjs(options);
		const runtime = module.newRuntime();
		const vm = runtime.newContext({ intrinsics });
		try {
			return new QuickJSFunctions(limits, runtime, vm, code);
		} catch (error) {
			if (vm.alive) {
				vm.dispose();
				runtime.dispose();
			}
			throw error;
		}
	}

	/** Runs a function; `now` is what Date and Date.now() report inside it (default: the host's time). */
	call(name: string, args: unknown[], now: number = Date.now()): unknown {
		if (this.#disposed) {
			throw new FunctionError('error', 'The sandbox is closed');
		}
		const fn = this.#functions.get(name);
		if (!fn) {
			throw new FunctionError('unknown-function', `No function "${name}"`);
		}
		const json = this.vm.newString(JSON.stringify(args));
		const time = this.vm.newNumber(now);
		try {
			const result = this.#run(() => this.vm.callFunction(this.#caller, this.vm.undefined, fn, json, time), `"${name}"`);
			const text = this.vm.getString(result);
			result.dispose();
			if (new TextEncoder().encode(text).length > this.limits.outputBytes) {
				throw new FunctionError('output', `"${name}" returned more than ${this.limits.outputBytes} bytes`);
			}
			return JSON.parse(text) as unknown;
		} finally {
			json.dispose();
			time.dispose();
		}
	}

	dispose(): void {
		if (this.#disposed) {
			return;
		}
		this.#disposed = true;
		for (const handle of this.#functions.values()) {
			handle.dispose();
		}
		this.#caller.dispose();
		this.vm.dispose();
		this.runtime.dispose();
	}

	/** Runs VM code under a deadline (the per-call one unless given) and turns VM errors into FunctionErrors. */
	#run(step: () => ReturnType<QuickJSContext['evalCode']>, what: string, budgetMs = this.limits.timeMs): QuickJSHandle {
		this.#deadline = performance.now() + budgetMs;
		let result: ReturnType<QuickJSContext['evalCode']>;
		try {
			result = step();
		} catch (error) {
			// getProp throws, rather than returning, what a getter throws.
			result = { error: this.vm.newError(error instanceof Error ? error.message : String(error)) } as ReturnType<QuickJSContext['evalCode']>;
		} finally {
			this.#deadline = 0;
		}
		if (result.error) {
			let error: { name?: string; message?: string } | string;
			try {
				// Outside the deadline, so a hostile error object cannot run code here.
				error = this.vm.dump(result.error) as typeof error;
			} catch {
				error = 'an error';
			} finally {
				result.error.dispose();
			}
			const message = typeof error === 'object' && error !== null ? `${error.name ?? 'Error'}: ${error.message ?? ''}` : String(error);
			if (/interrupted/i.test(message)) {
				throw new FunctionError('timeout', `${what} ran longer than ${budgetMs} ms and was stopped`);
			}
			if (/out of memory/i.test(message)) {
				throw new FunctionError('memory', `${what} used more than ${this.limits.memoryBytes} bytes of memory`);
			}
			throw new FunctionError('error', `${what} threw ${message}`);
		}
		return result.value;
	}
}

