import { createSnapshotEmitter, type EvalContext, type Snapshot, type SnapshotAction } from '@swissspidy/graft-core';
import type { A2UIBuild } from './types.ts';
import { INPUT_GROUP, walkA2UI, type A2UIHost, type DrawnButton } from './walk.ts';

/** A drawn button as the verifier sees it: a local `set` is kept like what the viewer enters. */
function snapshotAction(button: DrawnButton): SnapshotAction {
	const { set, variant: _variant, ...rest } = button;
	return set ? { ...rest, event: { group: INPUT_GROUP, name: set.target, payload: set.value } } : rest;
}

/**
 * Reads an A2UI surface into Graft's semantic snapshot, with the Graft
 * catalog: what the viewer reads and what they can do.
 * `entered` holds what the viewer typed (by input component id) and what
 * local actions set (by pointer), in order.
 */
export function snapshotA2UI(build: A2UIBuild, ctx: EvalContext, entered: Record<string, Record<string, unknown>>, host: A2UIHost): Snapshot {
	const { snapshot, emit } = createSnapshotEmitter();
	walkA2UI(build, ctx, entered, host, {
		text: (text, variant) => {
			if (variant !== 'divider') {
				emit.text(text);
			}
		},
		button: (button) => emit.action(snapshotAction(button)),
		input: ({ id, label, value }) => {
			(snapshot.inputs ??= []).push({ group: INPUT_GROUP, id, label, value });
			emit.text(label);
		},
		table: (table) => {
			emit.table({
				columns: table.columns,
				rows: table.rows.map((row) => ({ ...row, cells: row.cells as never, actions: row.actions.map(snapshotAction) })),
			});
			if (table.rows.length === 0) {
				emit.text(table.empty);
			}
		},
		group: (_kind, draw) => draw(),
		problem: (text) => {
			const problems = (snapshot.problems ??= []);
			if (!problems.includes(text)) {
				problems.push(text);
			}
		},
	});
	return snapshot;
}
