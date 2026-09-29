import { evaluate, type Action, type EvalContext } from '../build/evaluate.ts';
import type { TreeNode, Value } from '../build/types.ts';

/**
 * A semantic snapshot of a rendered build for one user: what they can read
 * and what they can do. Checks assert over snapshots, not pixels or DOM.
 */
export interface Snapshot {
	/** Every visible text, in tree order. */
	texts: string[];
	tables: SnapshotTable[];
	/** Actions outside tables (buttons, row actions). */
	actions: SnapshotAction[];
}

export interface SnapshotTable {
	columns: string[];
	rows: SnapshotRow[];
}

export interface SnapshotRow {
	/** The row's primary label, e.g. the post title. */
	label: string;
	record: unknown;
	actions: SnapshotAction[];
	/** What each column shows for the row, by column label. */
	cells?: Record<string, SnapshotCell>;
}

export interface SnapshotCell {
	text: string;
	/** A host tone (e.g. success, warning, error) the cell is marked with. */
	tone?: string;
}

export interface SnapshotAction {
	id: string;
	label: string;
	available: boolean;
	/** The evaluated `$call`, when there is one. */
	action?: Action;
	/** The record the action applies to: a table row or a slot instance. */
	row?: unknown;
}

/** What a component contributes to a snapshot. */
export interface SnapshotEmitter {
	text(text: string): void;
	table(table: SnapshotTable): void;
	action(action: SnapshotAction): void;
}

export interface SemanticsArgs {
	node: TreeNode;
	/** Props evaluated in the node's context. */
	props: Record<string, unknown>;
	raw: Record<string, Value>;
	/** Evaluates a raw value, optionally for a row. */
	evaluate(value: Value | undefined, row?: unknown): unknown;
	emit: SnapshotEmitter;
}

/**
 * How each component of a host surface reads in a snapshot. Provided by the
 * host adapter next to its component implementations. Return false to hide
 * the node's children (for example, a container that is not visible).
 */
export type ComponentSemantics = Record<string, (args: SemanticsArgs) => void | false>;

/**
 * Interprets a tree into a snapshot. Components without semantics
 * contribute their text children, if any.
 */
export function snapshotTree(tree: TreeNode, ctx: EvalContext, semantics: ComponentSemantics): Snapshot {
	const snapshot: Snapshot = { texts: [], tables: [], actions: [] };
	const emit: SnapshotEmitter = {
		text: (text) => {
			if (text.trim()) {
				snapshot.texts.push(text.trim());
			}
		},
		table: (table) => {
			snapshot.tables.push(table);
			for (const row of table.rows) {
				emit.text(row.label);
			}
		},
		action: (action) => {
			snapshot.actions.push(action);
		},
	};

	const visit = (node: TreeNode): void => {
		const raw = (node.props ?? {}) as Record<string, Value>;
		const props = evaluate(raw, ctx) as Record<string, unknown>;
		const describe = semantics[node.type];
		const result = describe?.({
			node,
			props,
			raw,
			evaluate: (value, row) => evaluate(value, row === undefined ? ctx : { ...ctx, row }),
			emit,
		});
		if (result === false) {
			return;
		}
		if (typeof node.children === 'string') {
			if (!describe) {
				emit.text(node.children);
			}
		} else {
			node.children?.forEach(visit);
		}
	};
	visit(tree);
	return snapshot;
}

/** All actions in a snapshot, including per-row table actions. */
export function allActions(snapshot: Snapshot): SnapshotAction[] {
	return [...snapshot.actions, ...snapshot.tables.flatMap((table) => table.rows.flatMap((row) => row.actions))];
}
