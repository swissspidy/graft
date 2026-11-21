/**
 * The service worker's storage, in order. Every change to stored state
 * (the log, approvals, safe mode, pauses) is a step of one queue, so two
 * changes at once never drop each other. A step can also act (`exclusive`):
 * a trigger's last check of safe mode, pauses and its grant, and the call
 * it then makes, are one step, so a control saved before the step is seen
 * by the check, and one saved during it waits until the call is made.
 */

export interface Storage {
	get(key: string): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
}

export interface Queue {
	/** Changes one stored value, after every step queued before. */
	update<T>(key: string, fallback: T, change: (value: T) => T): Promise<void>;
	/** Reads a stored value once every step queued before is done. */
	read<T>(key: string, fallback: T): Promise<T>;
	/** Runs `step` as one step of the queue; it reads with `peek`, since `read` would wait for the step itself. */
	exclusive<T>(step: (peek: <V>(key: string, fallback: V) => Promise<V>) => Promise<T>): Promise<T>;
}

export function createQueue(storage: Storage): Queue {
	let tail: Promise<unknown> = Promise.resolve();
	const peek = async <V>(key: string, fallback: V): Promise<V> => ((await storage.get(key))[key] as V | undefined) ?? fallback;
	const enqueue = <T>(step: () => Promise<T>): Promise<T> => {
		const next = tail.then(step);
		tail = next.catch(() => {});
		return next;
	};
	return {
		update: (key, fallback, change) => enqueue(async () => storage.set({ [key]: change(await peek(key, fallback)) })),
		read: async (key, fallback) => {
			await tail;
			return peek(key, fallback);
		},
		exclusive: (step) => enqueue(() => step(peek)),
	};
}
