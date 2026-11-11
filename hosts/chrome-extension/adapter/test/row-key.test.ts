import { describe, expect, it } from 'vitest';
import { rowKey } from '../src/host/a2ui.ts';
import { rowKey as emdashRowKey } from '../../../emdash/adapter/src/host/blocks.ts';

describe('what identifies a row in a click', () => {
	for (const [host, key] of [
		['browser', rowKey],
		['emdash', emdashRowKey],
	] as const) {
		it(`is its id, else what it holds, never where it is (${host})`, () => {
			expect(key({ id: 7, title: 'A' }, 3)).toBe('7');
			const b = { title: 'B' };
			// The same row at another position keeps its key; another row at its old position has another.
			expect(key(b, 1)).toBe(key({ title: 'B' }, 0));
			expect(key({ title: 'C' }, 1)).not.toBe(key(b, 1));
			expect(key(b, 1)).not.toContain('#');
		});
	}
});
