/**
 * Puts a list of elements into a parent in order, touching only what
 * changed: elements that stay where they are are never detached, so a
 * focused button inside one keeps its focus. Elements no longer listed are
 * removed; new or moved ones are inserted at their place.
 */

/** The part of the DOM this needs, so it can be tested without one. */
export interface Parent<N> {
	readonly children: ArrayLike<N>;
	insertBefore(node: N, before: N | null): unknown;
	removeChild(node: N): unknown;
}

export function reconcile<N>(parent: Parent<N>, nodes: N[]): void {
	const wanted = new Set(nodes);
	for (const child of Array.from(parent.children)) {
		if (!wanted.has(child)) {
			parent.removeChild(child);
		}
	}
	nodes.forEach((node, i) => {
		const at = parent.children[i] ?? null;
		if (at !== node) {
			parent.insertBefore(node, at);
		}
	});
}
