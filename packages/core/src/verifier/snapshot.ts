import { evaluate, type Action, type EvalContext } from '../build/evaluate.ts';
import type { TreeNode, Value } from '../build/types.ts';
import { initialState, isWidgetEvent, renderArgs, sanitizeWidgetTree, WIDGET, widgetProps, type WidgetLimits, type WidgetProps } from '../build/widgets.ts';

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
	/** Widgets drawn, by node path: what they were given and the state they drew. */
	widgets?: Record<string, { props: WidgetProps; state: unknown }>;
	/** What went wrong while drawing (a widget's render failing, or drawing something invalid). */
	problems?: string[];
}

/** How widgets are drawn in a snapshot. */
export interface SnapshotWidgets {
	limits: WidgetLimits;
	/** The state a widget is in; `has` is false while it is in its initial state (a stored null is a state). */
	state(path: string): { has: boolean; value?: unknown };
	/** Problems with a sanitized tree, e.g. props that do not match the surface. */
	validate?(tree: TreeNode): string[];
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
	/** A widget event instead of a `$call`: using it updates that widget's state. */
	event?: { widget: string; name: string; payload?: unknown };
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
export function snapshotTree(tree: TreeNode, ctx: EvalContext, semantics: ComponentSemantics, widgets?: SnapshotWidgets): Snapshot {
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

	const problem = (text: string) => (snapshot.problems ??= []).push(text);

	const visit = (node: TreeNode, path: string, out: SnapshotEmitter): void => {
		const raw = (node.props ?? {}) as Record<string, Value>;
		const props = evaluate(raw, ctx) as Record<string, unknown>;
		if (node.type === WIDGET) {
			drawWidget(props, path);
			return;
		}
		const describe = semantics[node.type];
		const result = describe?.({
			node,
			props,
			raw,
			evaluate: (value, row) => evaluate(value, row === undefined ? ctx : { ...ctx, row }),
			emit: out,
		});
		if (result === false) {
			return;
		}
		if (typeof node.children === 'string') {
			if (!describe) {
				out.text(node.children);
			}
		} else {
			node.children?.forEach((child, i) => visit(child, `${path}/children/${i}`, out));
		}
	};

	/** Draws a widget with its current state; its event buttons become actions that update it. */
	const drawWidget = (props: Record<string, unknown>, path: string): void => {
		const wp = widgetProps(props);
		if (!wp || !widgets || !ctx.fn) {
			problem(`The widget at ${path} cannot be drawn here.`);
			return;
		}
		const stored = widgets.state(path);
		const state = stored.has ? stored.value : initialState(wp);
		(snapshot.widgets ??= {})[path] = { props: wp, state };
		const drawn = ctx.fn(wp.render, renderArgs(wp, state));
		if (drawn === null || drawn === undefined) {
			problem(`The widget at ${path} drew nothing.`);
			return;
		}
		const { tree: sub, problems } = sanitizeWidgetTree(drawn, widgets.limits);
		problems.forEach((p) => problem(`The widget at ${path}: ${p}`));
		if (!sub) {
			return;
		}
		widgets.validate?.(sub).forEach((p) => problem(`The widget at ${path}: ${p}`));
		const inWidget: SnapshotEmitter = {
			...emit,
			action: (action) => {
				if (isWidgetEvent(action.action)) {
					const { $event, payload } = action.action;
					const { action: _, ...rest } = action;
					emit.action({ ...rest, event: { widget: path, name: $event, ...(payload !== undefined ? { payload } : {}) } });
				} else {
					// Code cannot make actions: only events reach a widget's buttons.
					emit.action({ ...action, available: false });
				}
			},
			table: (table) =>
				emit.table({
					...table,
					rows: table.rows.map((row) => ({
						...row,
						actions: row.actions.map((a) => {
							if (!isWidgetEvent(a.action)) {
								return { ...a, available: false };
							}
							const { $event, payload } = a.action;
							const { action: _, ...rest } = a;
							return { ...rest, event: { widget: path, name: $event, ...(payload !== undefined ? { payload } : {}) } };
						}),
					})),
				}),
		};
		visit(sub, `${path}/widget`, inWidget);
	};

	visit(tree, '/tree', emit);
	return snapshot;
}

/** All actions in a snapshot, including per-row table actions. */
export function allActions(snapshot: Snapshot): SnapshotAction[] {
	return [...snapshot.actions, ...snapshot.tables.flatMap((table) => table.rows.flatMap((row) => row.actions))];
}
