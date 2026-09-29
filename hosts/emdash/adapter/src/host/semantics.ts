import type { ComponentSemantics, SemanticsArgs, SnapshotAction } from '@graft/core';
import { components } from './components.ts';
import { nodeOutput, type RenderedAction } from './blocks.ts';

/**
 * How EmDash components read in a semantic snapshot. Derived from the Block
 * Kit translation itself (nodeOutput), so what the verifier sees is what
 * the plugin sends to the admin.
 */

const toSnapshot = (action: RenderedAction): SnapshotAction => {
	const snapshot: SnapshotAction = { id: action.id, label: action.label, available: action.available };
	if (action.action) {
		snapshot.action = action.action;
	}
	if (action.row !== undefined) {
		snapshot.row = action.row;
	}
	return snapshot;
};

function describe({ node, props, raw, evaluate, emit }: SemanticsArgs): void | false {
	if (props.visible === false && node.type !== 'button') {
		return false;
	}
	const output = nodeOutput({ type: node.type, props, raw, evaluateRow: (value, row) => evaluate(value, row), actionPrefix: 'snapshot' });
	output.texts.forEach(emit.text);
	output.actions.forEach((action) => emit.action(toSnapshot(action)));
	if (output.table) {
		emit.table({
			columns: output.table.columns,
			rows: output.table.rows.map((row) => ({ label: row.label, record: row.record, actions: row.actions.map(toSnapshot) })),
		});
	}
}

export const semantics: ComponentSemantics = Object.fromEntries(Object.keys(components).map((type) => [type, describe]));
