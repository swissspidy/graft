import {
	evaluate,
	getPath,
	initialState,
	isAction,
	isWidgetEvent,
	renderArgs,
	resolveWidgetUse,
	sanitizeWidgetTree,
	WIDGET,
	widgetProps,
	type Action,
	type EvalContext,
	type TreeNode,
	type Value,
	type WidgetLimits,
	type WidgetProps,
	type WidgetUse,
} from '@graft/core/runtime';

/**
 * Translates a build's tree into EmDash Block Kit. The admin draws the
 * blocks; interactions come back to the plugin as `block_action` with the
 * action id and value set here, and the plugin resolves them against a
 * fresh render (see `renderTree().actions`), so the browser never supplies
 * a capability or its input.
 *
 * Widgets are drawn here too, on the server: their code's tree is rendered
 * like the build's own. The admin keeps no state for them, so each button
 * of a customization with widgets carries the widgets' states in its value
 * (see `withWidgetStates`); a click re-renders with those states and finds
 * the button again, and an event button's payload comes from that render,
 * never from the browser. A forged state only changes what the code draws:
 * actions it offers still resolve against the rows the server loaded, and
 * pass the declared `visible` condition and the gateway.
 */

/** A Block Kit block or element, as JSON. */
export type Block = Record<string, unknown> & { type: string };

/** A button a render produced, keyed by the id and value the admin sends back. */
export interface RenderedAction {
	/** The action id from the build (e.g. "approve"). */
	id: string;
	label: string;
	available: boolean;
	action?: Action;
	/** The table row the action belongs to. */
	row?: unknown;
	/** A widget's event button: using it updates that widget's state. */
	event?: { widget: string; name: string; payload?: unknown };
	/** Block Kit `action_id` and `value` of the button. */
	actionId: string;
	value?: string;
}

export interface NodeOutput {
	blocks: Block[];
	/** Buttons for an enclosing "actions" block (from a button). */
	elements: Block[];
	/** Buttons outside tables; a table's are on its rows. */
	actions: RenderedAction[];
	/** Visible text, except table row labels. */
	texts: string[];
	table?: { columns: string[]; rows: Array<{ label: string; record: unknown; actions: RenderedAction[]; cells: Record<string, { text: string; tone?: Tone }> }> };
}

export interface NodeArgs {
	type: string;
	/** Props evaluated in the node's context. */
	props: Record<string, unknown>;
	raw: Record<string, Value>;
	/** Evaluates a raw value for a row. */
	evaluateRow(value: Value | undefined, row: unknown): unknown;
	/** Prefix for action ids: unique per customization and node. */
	actionPrefix: string;
	/** The widget the node is drawn in, if any: only its buttons send events. */
	widget?: string;
}

export type Tone = 'success' | 'warning' | 'error' | 'info';

/**
 * Block Kit cannot color a table cell, so a tone shows as a marker before
 * the value. Relative times are left unmarked: the admin formats them.
 */
export const toneMarkers: Record<Tone, string> = { success: '🟢', warning: '🟡', error: '🔴', info: '🔵' };

const str = (value: unknown): string => (value === null || value === undefined ? '' : typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value));

/** The value that identifies a row in an action: its id, else its position. */
export function rowKey(row: unknown, index: number): string {
	const id = typeof row === 'object' && row !== null ? (row as { id?: unknown }).id : undefined;
	return typeof id === 'string' || typeof id === 'number' ? String(id) : `#${index}`;
}

export function button(props: Record<string, unknown>, actionId: string, widget: string | undefined, value?: string, row?: unknown): { element?: Block; action: RenderedAction } {
	const onClick = props.onClick;
	const event = widget !== undefined && isWidgetEvent(onClick) ? onClick : undefined;
	const available = props.visible !== false && props.disabled !== true && (isAction(onClick) || event !== undefined);
	const action: RenderedAction = { id: str(props.id), label: str(props.label), available, actionId };
	if (isAction(onClick)) {
		action.action = onClick;
	}
	if (event) {
		action.event = { widget: widget!, name: event.$event, ...(event.payload !== undefined ? { payload: event.payload } : {}) };
	}
	if (value !== undefined) {
		action.value = value;
	}
	if (row !== undefined) {
		action.row = row;
	}
	if (!available) {
		return { action };
	}
	const element: Block = { type: 'button', action_id: actionId, label: action.label };
	if (props.style === 'primary' || props.style === 'danger') {
		element.style = props.style;
	}
	if (value !== undefined) {
		element.value = value;
	}
	if (typeof props.confirm === 'string') {
		element.confirm = { title: props.confirm, text: '', confirm: action.label, deny: 'Cancel', ...(props.style === 'danger' ? { style: 'danger' } : {}) };
	}
	return { element, action };
}

/** One node's blocks, buttons and snapshot contributions. Children are the caller's. */
export function nodeOutput({ type, props, raw, evaluateRow, actionPrefix, widget }: NodeArgs): NodeOutput {
	const out: NodeOutput = { blocks: [], elements: [], actions: [], texts: [] };
	const text = (value: unknown) => {
		const s = str(value).trim();
		if (s) {
			out.texts.push(s);
		}
		return s;
	};
	switch (type) {
		case 'header':
		case 'section':
		case 'context':
			out.blocks.push({ type, text: text(props.text) });
			break;
		case 'divider':
			out.blocks.push({ type: 'divider' });
			break;
		case 'banner': {
			if (props.visible === false) {
				break;
			}
			const block: Block = { type: 'banner', variant: props.variant ?? 'default' };
			if (props.title !== undefined) {
				block.title = text(props.title);
			}
			if (props.text !== undefined) {
				block.description = text(props.text);
			}
			out.blocks.push(block);
			break;
		}
		case 'empty': {
			if (props.visible === false) {
				break;
			}
			const block: Block = { type: 'empty', title: text(props.title) };
			if (props.text !== undefined) {
				block.description = text(props.text);
			}
			out.blocks.push(block);
			break;
		}
		case 'fields':
		case 'stats': {
			const items = Array.isArray(props.items) ? (props.items as Array<Record<string, unknown>>) : [];
			const mapped = items.map((item) => {
				const entry: Record<string, unknown> = { label: text(item.label), value: text(item.value) };
				if (type === 'stats' && item.description !== undefined) {
					entry.description = text(item.description);
				}
				return entry;
			});
			out.blocks.push(type === 'fields' ? { type, fields: mapped } : { type, items: mapped });
			break;
		}
		case 'button': {
			const { element, action } = button(props, actionPrefix, widget);
			if (element) {
				out.elements.push(element);
			}
			out.actions.push(action);
			break;
		}
		case 'table': {
			const columns = (Array.isArray(props.columns) ? props.columns : []) as Array<{ key: string; label: string; format?: string; primary?: boolean }>;
			const primary = columns.find((c) => c.primary) ?? columns[0];
			const rows = Array.isArray(props.rows) ? (props.rows as unknown[]) : [];
			const rawActions = (Array.isArray(raw.actions) ? raw.actions : []) as Value[];
			// Computed values and tones are expressions per row, so read them unevaluated.
			// When the columns themselves come from an expression, use them as evaluated.
			const rawColumns = (Array.isArray(raw.columns) ? raw.columns : columns) as Array<{ value?: Value; tone?: Value } | undefined>;
			const table: NonNullable<NodeOutput['table']> = { columns: columns.map((c) => c.label), rows: [] };
			const blockColumns: Block[] = columns.map((c) => ({ key: `c${columns.indexOf(c)}`, label: c.label, ...(c.format && c.format !== 'text' ? { format: c.format } : {}) }) as unknown as Block);
			const actionIds = rawActions.map((_, i) => `${actionPrefix}:${i}`);
			for (const id of actionIds) {
				blockColumns.push({ key: id, label: '', format: 'element' } as unknown as Block);
			}
			const blockRows = rows.map((row, index) => {
				const cells: Record<string, unknown> = {};
				const snapshotCells: Record<string, { text: string; tone?: Tone }> = {};
				columns.forEach((c, i) => {
					const computed = rawColumns[i];
					const text = str(computed?.value !== undefined ? evaluateRow(computed.value, row) : getPath(row, c.key));
					const tone = computed?.tone !== undefined ? evaluateRow(computed.tone, row) : undefined;
					// Only a tone the admin shows: never on relative times or empty cells.
					if (typeof tone === 'string' && Object.hasOwn(toneMarkers, tone) && c.format !== 'relative_time' && text !== '') {
						snapshotCells[c.label] = { text, tone: tone as Tone };
						cells[`c${i}`] = `${toneMarkers[tone as Tone]} ${text}`;
					} else {
						snapshotCells[c.label] = { text };
						cells[`c${i}`] = text;
					}
				});
				const value = rowKey(row, index);
				const actions = rawActions.map((rawAction, i) => {
					const resolved = (evaluateRow(rawAction, row) ?? {}) as Record<string, unknown>;
					const { element, action } = button(resolved, actionIds[i]!, widget, value, row);
					if (element) {
						cells[actionIds[i]!] = element;
					}
					return action;
				});
				// The label is what the primary column shows, computed or not.
				table.rows.push({ label: primary ? (snapshotCells[primary.label]?.text ?? '') : '', record: row, actions, cells: snapshotCells });
				return cells;
			});
			out.table = table;
			const block: Block = { type: 'table', columns: blockColumns, rows: blockRows, page_action_id: `${actionPrefix}:page` };
			if (props.empty !== undefined) {
				block.empty_text = str(props.empty);
				if (rows.length === 0) {
					text(props.empty);
				}
			}
			out.blocks.push(block);
			break;
		}
		default:
			break;
	}
	return out;
}

export interface Rendered {
	blocks: Block[];
	/** Every button, available or not, in tree order. */
	actions: RenderedAction[];
	/** Widgets drawn, by node path: what they were given and the state they drew. */
	widgets: Record<string, { props: WidgetProps; state: unknown }>;
	/** What went wrong while drawing: a widget that cannot be drawn, or drew something invalid. */
	problems: string[];
}

/** How widgets are drawn in a render. */
export interface RenderWidgets {
	limits: WidgetLimits;
	/** Widget states by node path; a widget without one is in its initial state. */
	states: Record<string, unknown>;
	/** Problems with a sanitized tree, e.g. props that do not match the surface. */
	validate?(tree: TreeNode): string[];
}

/**
 * Renders a tree for a context. `prefix` namespaces action ids, so several
 * customizations can share a widget or panel. Widgets need `widgets` and a
 * `ctx.fn` to run their code.
 */
export function renderTree(tree: TreeNode, ctx: EvalContext, prefix: string, widgets?: RenderWidgets): Rendered {
	const rendered: Rendered = { blocks: [], actions: [], widgets: {}, problems: [] };
	const problem = (text: string) => {
		if (!rendered.problems.includes(text)) {
			rendered.problems.push(text);
		}
	};
	const visit = (node: TreeNode, path: string, at: EvalContext, widget?: string): Block[] => {
		const raw = (node.props ?? {}) as Record<string, Value>;
		const props = evaluate(raw as Value, at) as Record<string, unknown>;
		if (node.type === WIDGET) {
			return drawWidget(raw, props, path, at);
		}
		if (props.visible === false && node.type !== 'button') {
			return [];
		}
		const output = nodeOutput({
			type: node.type,
			props,
			raw,
			evaluateRow: (value, row) => evaluate(value, { ...at, row }),
			actionPrefix: `${prefix}:${path}`,
			...(widget !== undefined ? { widget } : {}),
		});
		rendered.actions.push(...output.actions, ...(output.table?.rows.flatMap((row) => row.actions) ?? []));
		const children = Array.isArray(node.children) ? node.children : [];
		const inner: Block[] = [];
		children.forEach((child, i) => {
			inner.push(...visit(child, `${path}.${i}`, at, widget));
		});
		if (node.type === 'actions') {
			const elements = inner.filter(isElement);
			return elements.length > 0 ? [{ type: 'actions', elements }] : [];
		}
		return [...output.blocks, ...output.elements, ...inner];
	};

	/** Draws a widget in its current state: its code's tree, sanitized, rendered like the build's own. */
	const drawWidget = (raw: Record<string, Value>, props: Record<string, unknown>, path: string, at: EvalContext): Block[] => {
		const wp = widgetProps(props);
		if (!wp || !widgets || !at.fn) {
			problem('A widget cannot be drawn here.');
			return [];
		}
		const state = Object.hasOwn(widgets.states, path) ? widgets.states[path] : initialState(wp);
		rendered.widgets[path] = { props: wp, state };
		const drawn = at.fn(wp.render, renderArgs(wp, state));
		if (drawn === null || drawn === undefined) {
			problem('A widget drew nothing.');
			return [];
		}
		const { tree: sub, problems } = sanitizeWidgetTree(drawn, widgets.limits);
		problems.forEach((p) => problem(`A widget: ${p}`));
		if (!sub) {
			return [];
		}
		widgets.validate?.(sub).forEach((p) => problem(`A widget: ${p}`));
		// Uses of the widget's declared actions resolve to the action for one of its rows, or null (hidden).
		const use = (marker: WidgetUse): unknown => {
			const resolved = resolveWidgetUse(marker, raw.actions, props.input, at);
			if (resolved.problem) {
				problem(`A widget: ${resolved.problem}`);
			}
			return resolved.available && resolved.action ? resolved.action : null;
		};
		return visit(sub, `${path}.w`, { ...at, use }, path);
	};

	rendered.blocks = wrapElements(visit(tree, '0', ctx));
	return rendered;
}

/** Marks a button value that carries widget states. */
const STATES = 'w|';

/**
 * Puts the states of a render's widgets into the value of each of its
 * buttons (those with the render's prefix), so a click brings them back.
 * Renders without widgets are left as they are.
 */
export function withWidgetStates(rendered: Rendered, prefix: string): Rendered {
	const paths = Object.keys(rendered.widgets);
	if (paths.length === 0) {
		return rendered;
	}
	const states = Object.fromEntries(paths.map((path) => [path, rendered.widgets[path]!.state]));
	const rewrite = (item: unknown): void => {
		if (Array.isArray(item)) {
			item.forEach(rewrite);
			return;
		}
		if (typeof item !== 'object' || item === null) {
			return;
		}
		const block = item as Block;
		if (block.type === 'button' && typeof block.action_id === 'string' && block.action_id.startsWith(`${prefix}:`)) {
			const value = typeof block.value === 'string' ? block.value : undefined;
			block.value = STATES + JSON.stringify(value === undefined ? { w: states } : { v: value, w: states });
			return;
		}
		Object.values(block).forEach(rewrite);
	};
	rewrite(rendered.blocks);
	return rendered;
}

/** A button value as the admin sent it back: the button's own value and the widget states it carried. */
export function readValue(value: unknown): { value: unknown; states: Record<string, unknown> } {
	if (typeof value === 'string' && value.startsWith(STATES)) {
		try {
			const parsed = JSON.parse(value.slice(STATES.length)) as { v?: unknown; w?: unknown };
			const states = typeof parsed.w === 'object' && parsed.w !== null && !Array.isArray(parsed.w) ? (parsed.w as Record<string, unknown>) : {};
			return { value: typeof parsed.v === 'string' ? parsed.v : undefined, states };
		} catch {
			// Not ours: a row id that happens to look like it.
		}
	}
	return { value, states: {} };
}

const isElement = (block: Block) => block.type === 'button';

/** Buttons outside an "actions" node become an actions block of their own. */
function wrapElements(blocks: Block[]): Block[] {
	const out: Block[] = [];
	for (const block of blocks) {
		if (!isElement(block)) {
			out.push(block);
			continue;
		}
		const last = out.at(-1);
		if (last?.type === 'actions' && (last as { graftLoose?: boolean }).graftLoose) {
			(last.elements as Block[]).push(block);
		} else {
			out.push({ type: 'actions', elements: [block], graftLoose: true });
		}
	}
	return out.map((block) => {
		if (block.type !== 'actions' || !('graftLoose' in block)) {
			return block;
		}
		const { graftLoose: _, ...rest } = block;
		return rest as Block;
	});
}

/** The action a `block_action` refers to, if the fresh render still offers it. */
export function findAction(rendered: Rendered, actionId: string, value: unknown): RenderedAction | undefined {
	return rendered.actions.find((a) => a.available && a.actionId === actionId && (a.value ?? undefined) === (value ?? undefined));
}
