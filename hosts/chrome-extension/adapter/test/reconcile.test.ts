import { describe, expect, it } from 'vitest';
import { reconcile, type Parent } from '../src/extension/reconcile.ts';

/** A parent that records every node it detaches, as removing or moving a DOM node does. */
function parent(initial: string[]): Parent<string> & { list: string[]; detached: string[] } {
	const list = [...initial];
	const detached: string[] = [];
	return {
		list,
		detached,
		get children() {
			return list;
		},
		insertBefore(node, before) {
			const from = list.indexOf(node);
			if (from >= 0) {
				list.splice(from, 1);
				detached.push(node);
			}
			list.splice(before === null ? list.length : list.indexOf(before), 0, node);
		},
		removeChild(node) {
			list.splice(list.indexOf(node), 1);
			detached.push(node);
		},
	};
}

describe('reconciling the side panel', () => {
	it('leaves views that stay attached when another one comes or goes', () => {
		const added = parent(['a', 'b']);
		reconcile(added, ['a', 'b', 'c']);
		expect(added.list).toEqual(['a', 'b', 'c']);
		expect(added.detached).toEqual([]);

		const removed = parent(['a', 'b', 'c']);
		reconcile(removed, ['a', 'c']);
		expect(removed.list).toEqual(['a', 'c']);
		expect(removed.detached).toEqual(['b']);

		const inserted = parent(['a', 'c']);
		reconcile(inserted, ['a', 'b', 'c']);
		expect(inserted.list).toEqual(['a', 'b', 'c']);
		expect(inserted.detached).toEqual([]);
	});

	it('replaces the empty state, and changes nothing when nothing changed', () => {
		const empty = parent(['empty']);
		reconcile(empty, ['a']);
		expect(empty.list).toEqual(['a']);
		const same = parent(['a', 'b']);
		reconcile(same, ['a', 'b']);
		expect(same.detached).toEqual([]);
	});
});
