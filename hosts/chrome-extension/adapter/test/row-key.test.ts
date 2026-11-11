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
			// An id is never mistaken for the content of a row without one.
			expect(key({ id: '~{"name":"B"}' }, 0)).not.toBe(key({ name: 'B' }, 0));
			expect(key({ id: '=~x' }, 0)).not.toBe(key({ id: '~x' }, 0));
			const b = { title: 'B' };
			// The same row at another position keeps its key; another row at its old position has another.
			expect(key(b, 1)).toBe(key({ title: 'B' }, 0));
			expect(key({ title: 'C' }, 1)).not.toBe(key(b, 1));
			expect(key(b, 1)).not.toContain('#');
			// Two rows a single 32-bit FNV-1a hash cannot tell apart are told apart.
			expect(key({ name: 'ae60045d38674386' }, 0)).not.toBe(key({ name: 'afaebb77f983fdc4' }, 0));
			const long = (name: string) => ({ name, note: 'x'.repeat(80) });
			expect(key(long('ae60045d38674386'), 0)).not.toBe(key(long('afaebb77f983fdc4'), 0));
			expect(key(long('a'), 0)).toBe(key(long('a'), 5));
		});
	}
});
