import { describe, expect, it } from 'vitest';
import { createQueue, type Storage } from '../src/extension/queue.ts';

/** chrome.storage.local in memory, answering on a later tick as Chrome does. */
function memory(): Storage & { data: Record<string, unknown> } {
	const data: Record<string, unknown> = {};
	const later = () => new Promise((resolve) => setTimeout(resolve, 1));
	return {
		data,
		async get(key) {
			await later();
			return key in data ? { [key]: data[key] } : {};
		},
		async set(items) {
			await later();
			Object.assign(data, items);
		},
	};
}

/** A trigger's call step: the last check of safe mode, then the call, which waits on `release`. */
function callStep(queue: ReturnType<typeof createQueue>, calls: string[], release: Promise<void>) {
	return queue.exclusive(async (peek) => {
		if (await peek('safeMode', false)) {
			throw new Error('stopped');
		}
		calls.push('started');
		await release;
		calls.push('done');
	});
}

describe('the storage queue', () => {
	it('lets no control be saved while a call is starting, and no call start after one is saved', async () => {
		for (const control of ['safeMode', 'triggersPaused', 'customizations'] as const) {
			const storage = memory();
			const queue = createQueue(storage);
			const calls: string[] = [];
			let release!: () => void;
			const first = callStep(queue, calls, new Promise<void>((resolve) => (release = resolve)));
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(calls).toEqual(['started']);

			// The person turns safe mode on (or pauses, or revokes) while the call is waiting.
			const saved = queue.update(control, null as unknown, () => (control === 'customizations' ? {} : true));
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(storage.data[control]).toBeUndefined();

			release();
			await first;
			await saved;
			expect(storage.data[control]).toBeDefined();
			expect(calls).toEqual(['started', 'done']);
		}
	});

	it('shows the next call a control saved before it', async () => {
		const queue = createQueue(memory());
		const calls: string[] = [];
		void queue.update('safeMode', false, () => true);
		await expect(callStep(queue, calls, Promise.resolve())).rejects.toThrow('stopped');
		expect(calls).toEqual([]);
	});

	it('keeps two changes made at once', async () => {
		const storage = memory();
		const queue = createQueue(storage);
		await Promise.all([queue.update<string[]>('log', [], (log) => [...log, 'a']), queue.update<string[]>('log', [], (log) => [...log, 'b'])]);
		expect(storage.data.log).toEqual(['a', 'b']);
		expect(await queue.read('log', [])).toEqual(['a', 'b']);
	});
});
