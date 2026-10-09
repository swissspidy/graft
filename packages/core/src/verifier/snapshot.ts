import type { Action } from '../build/evaluate.ts';

/**
 * A semantic snapshot of a rendered build for one user: what they can read
 * and what they can do. Checks assert over snapshots, not pixels or DOM.
 */
export interface Snapshot {
	/** Every visible text, in document order. */
	texts: string[];
	tables: SnapshotTable[];
	/** Actions outside tables (buttons, row actions). */
	actions: SnapshotAction[];
	/** Input components drawn, with what they show. */
	inputs?: SnapshotInput[];
	/** What went wrong while drawing. */
	problems?: string[];
}

/** An input component, and what it shows. */
export interface SnapshotInput {
	/** The group the input belongs to (e.g. its surface); what the viewer entered is kept per group. */
	group: string;
	id: string;
	label?: string;
	value: unknown;
	/** The record it belongs to: the slot instance (e.g. the post). */
	row?: unknown;
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
	/** The capability call the action makes, when there is one. */
	action?: Action;
	/** The record the action applies to: a table row or a slot instance. */
	row?: unknown;
	/** A local event instead of a call: using it keeps `payload` under `name` in the group's entered values. */
	event?: { group: string; name: string; payload?: unknown };
}

/** What a component contributes to a snapshot. */
export interface SnapshotEmitter {
	text(text: string): void;
	table(table: SnapshotTable): void;
	action(action: SnapshotAction): void;
}

/**
 * A snapshot and the emitter that fills it. Components reading into a
 * snapshot go through the emitter, so every UI format reads the same way.
 */
export function createSnapshotEmitter(): { snapshot: Snapshot; emit: SnapshotEmitter } {
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
				for (const cell of Object.values(row.cells ?? {})) {
					if (cell.text !== row.label) {
						emit.text(cell.text);
					}
				}
				for (const action of row.actions) {
					if (action.available) {
						emit.text(action.label);
					}
				}
			}
		},
		action: (action) => {
			snapshot.actions.push(action);
			// An action the viewer can use shows its label (a button, a row action).
			if (action.available) {
				emit.text(action.label);
			}
		},
	};
	return { snapshot, emit };
}

/** All actions in a snapshot, including per-row table actions. */
export function allActions(snapshot: Snapshot): SnapshotAction[] {
	return [...snapshot.actions, ...snapshot.tables.flatMap((table) => table.rows.flatMap((row) => row.actions))];
}
