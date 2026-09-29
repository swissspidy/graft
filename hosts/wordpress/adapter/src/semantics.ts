import type { ComponentSemantics, SnapshotAction } from '@graft/core';

/**
 * How the WordPress components read in a semantic snapshot. Mirrors what
 * src/client/components.tsx renders: keep the two in step.
 */

interface Field {
	id: string;
	label: string;
	primary?: boolean;
}

function readPath(row: unknown, path: string): unknown {
	return path.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), row);
}

function actionFrom(value: unknown, row?: unknown): SnapshotAction {
	const action = value as { id?: unknown; label?: unknown; visible?: unknown; disabled?: unknown; onClick?: unknown };
	const snapshot: SnapshotAction = {
		id: String(action.id ?? ''),
		label: String(action.label ?? ''),
		available: action.visible !== false && action.disabled !== true,
		action: action.onClick as SnapshotAction['action'],
	};
	if (row !== undefined) {
		snapshot.row = row;
	}
	return snapshot;
}

export const semantics: ComponentSemantics = {
	card: ({ props, emit }) => {
		if (typeof props.title === 'string') {
			emit.text(props.title);
		}
	},
	'empty-state': ({ props, emit }) => {
		emit.text(String(props.title ?? ''));
		if (typeof props.description === 'string') {
			emit.text(props.description);
		}
	},
	button: ({ props, emit }) => {
		emit.action(actionFrom(props));
	},
	'row-action': ({ props, emit }) => {
		emit.action(actionFrom(props));
	},
	table: ({ props, raw, evaluate, emit }) => {
		const fields = (props.fields as Field[] | undefined) ?? [];
		const primary = fields.find((f) => f.primary) ?? fields[0];
		const rows = Array.isArray(props.rows) ? (props.rows as unknown[]) : [];
		const actions = Array.isArray(raw.actions) ? raw.actions : [];
		emit.table({
			columns: fields.map((f) => f.label),
			rows: rows.map((row) => ({
				label: primary ? String(readPath(row, primary.id) ?? '') : '',
				record: row,
				actions: actions.map((action) => actionFrom(evaluate(action, row), row)),
			})),
		});
		if (rows.length === 0) {
			emit.text(typeof props.empty === 'string' ? props.empty : 'No items.');
		}
	},
};
