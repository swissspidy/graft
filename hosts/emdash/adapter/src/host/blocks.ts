import { evaluate, getPath, isAction, type Action, type EvalContext, type TreeNode, type Value } from '@graft/core/runtime';

/**
 * Translates a build's tree into EmDash Block Kit. The admin draws the
 * blocks; interactions come back to the plugin as `block_action` with the
 * action id and value set here, and the plugin resolves them against a
 * fresh render (see `renderTree().actions`), so the browser never supplies
 * a capability or its input.
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
	table?: { columns: string[]; rows: Array<{ label: string; record: unknown; actions: RenderedAction[] }> };
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
}

const str = (value: unknown): string => (value === null || value === undefined ? '' : typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value));

/** The value that identifies a row in an action: its id, else its position. */
export function rowKey(row: unknown, index: number): string {
	const id = typeof row === 'object' && row !== null ? (row as { id?: unknown }).id : undefined;
	return typeof id === 'string' || typeof id === 'number' ? String(id) : `#${index}`;
}

function button(props: Record<string, unknown>, actionId: string, value?: string, row?: unknown): { element?: Block; action: RenderedAction } {
	const onClick = props.onClick;
	const available = props.visible !== false && props.disabled !== true && isAction(onClick);
	const action: RenderedAction = { id: str(props.id), label: str(props.label), available, actionId };
	if (isAction(onClick)) {
		action.action = onClick;
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
export function nodeOutput({ type, props, raw, evaluateRow, actionPrefix }: NodeArgs): NodeOutput {
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
			const { element, action } = button(props, actionPrefix);
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
			const table: NonNullable<NodeOutput['table']> = { columns: columns.map((c) => c.label), rows: [] };
			const blockColumns: Block[] = columns.map((c) => ({ key: `c${columns.indexOf(c)}`, label: c.label, ...(c.format && c.format !== 'text' ? { format: c.format } : {}) }) as unknown as Block);
			const actionIds = rawActions.map((_, i) => `${actionPrefix}:${i}`);
			for (const id of actionIds) {
				blockColumns.push({ key: id, label: '', format: 'element' } as unknown as Block);
			}
			const blockRows = rows.map((row, index) => {
				const cells: Record<string, unknown> = {};
				columns.forEach((c, i) => {
					cells[`c${i}`] = str(getPath(row, c.key));
				});
				const value = rowKey(row, index);
				const actions = rawActions.map((rawAction, i) => {
					const resolved = (evaluateRow(rawAction, row) ?? {}) as Record<string, unknown>;
					const { element, action } = button(resolved, actionIds[i]!, value, row);
					if (element) {
						cells[actionIds[i]!] = element;
					}
					return action;
				});
				table.rows.push({ label: primary ? str(getPath(row, primary.key)) : '', record: row, actions });
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
}

/**
 * Renders a tree for a context. `prefix` namespaces action ids, so several
 * customizations can share a widget or panel.
 */
export function renderTree(tree: TreeNode, ctx: EvalContext, prefix: string): Rendered {
	const rendered: Rendered = { blocks: [], actions: [] };
	const visit = (node: TreeNode, path: string): Block[] => {
		const raw = (node.props ?? {}) as Record<string, Value>;
		const props = evaluate(raw as Value, ctx) as Record<string, unknown>;
		if (props.visible === false && node.type !== 'button') {
			return [];
		}
		const output = nodeOutput({
			type: node.type,
			props,
			raw,
			evaluateRow: (value, row) => evaluate(value, { ...ctx, row }),
			actionPrefix: `${prefix}:${path}`,
		});
		rendered.actions.push(...output.actions, ...(output.table?.rows.flatMap((row) => row.actions) ?? []));
		const children = Array.isArray(node.children) ? node.children : [];
		const inner: Block[] = [];
		children.forEach((child, i) => {
			inner.push(...visit(child, `${path}.${i}`));
		});
		if (node.type === 'actions') {
			const elements = inner.filter(isElement);
			return elements.length > 0 ? [{ type: 'actions', elements }] : [];
		}
		return [...output.blocks, ...output.elements, ...inner];
	};
	rendered.blocks = wrapElements(visit(tree, '0'));
	return rendered;
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
