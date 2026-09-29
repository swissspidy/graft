import { evaluate, inert, isAction, type Action, type EvalContext } from './evaluate.ts';
import type { TreeNode, Value } from './types.ts';

/**
 * Interactive widgets: a `widget` node names two of the build's functions.
 * `render(input, state)` returns a tree of the host's own components, and
 * `update(state, event, payload, input)` returns the next state when the
 * viewer uses one of the tree's `{"$event": name, "payload": ...}` markers.
 *
 * Code never touches the page and never calls a capability: what it
 * returns is sanitized here into inert props on allow-listed components,
 * rendered by the host's trusted components. Its only live values are
 * markers: events that lead back to `update`, and uses of the widget's
 * declared actions (`{"$use": name, "row": id}`), which the host resolves
 * against the rows the widget was given. Code chooses which declared
 * action to offer on which of those rows, never what the action does.
 */

/** The component type that hosts a widget. */
export const WIDGET = 'widget';

export interface WidgetEvent {
	$event: string;
	payload?: unknown;
}

export const isWidgetEvent = (value: unknown): value is WidgetEvent =>
	typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { $event?: unknown }).$event === 'string';

/** Use of one of the widget's declared actions, on one row of its input. */
export interface WidgetUse {
	$use: string;
	/** The row's id, or a row carrying it (a table fills in its own row). */
	row?: unknown;
}

export const isWidgetUse = (value: unknown): value is WidgetUse =>
	typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { $use?: unknown }).$use === 'string';

/** An action a widget node declares: a `$call`, and when it is offered. */
export interface WidgetAction {
	call: Value;
	visible?: Value;
}

/** What a surface lets widgets draw with. */
export interface WidgetLimits {
	/** Components a widget's tree may use. */
	components: string[];
	/** Most nodes one render may return. */
	maxNodes: number;
}

/** The props of a widget node, evaluated. */
export interface WidgetProps {
	render: string;
	update?: string;
	input?: unknown;
	state?: unknown;
}

export type Sanitized = { tree: TreeNode; problems: string[] } | { tree?: undefined; problems: string[] };

const EVENT_NAME = /^[A-Za-z][\w.-]{0,63}$/;

/**
 * Turns what `render` returned into a tree the host may render: known node
 * shapes only, allow-listed component types, props as inert data except
 * event markers, and at most `maxNodes` nodes. Anything else is dropped and
 * reported; a root that is not a usable node yields no tree.
 */
export function sanitizeWidgetTree(value: unknown, limits: WidgetLimits): Sanitized {
	const problems: string[] = [];
	const allowed = new Set(limits.components);
	let count = 0;

	const prop = (item: unknown, depth: number): unknown => {
		if (isWidgetUse(item)) {
			if (!EVENT_NAME.test(item.$use)) {
				problems.push(`Action "${item.$use}" is not a valid name.`);
				return null;
			}
			return item.row === undefined ? { $use: item.$use } : { $use: item.$use, row: inert(item.row) };
		}
		if (isWidgetEvent(item)) {
			if (!EVENT_NAME.test(item.$event)) {
				problems.push(`Event "${item.$event}" is not a valid name.`);
				return null;
			}
			return item.payload === undefined ? { $event: item.$event } : { $event: item.$event, payload: inert(item.payload) };
		}
		if (Array.isArray(item) && depth < 8) {
			return item.map((entry) => prop(entry, depth + 1));
		}
		if (typeof item === 'object' && item !== null && !Array.isArray(item) && depth < 8 && !Object.keys(item).some((k) => k.startsWith('$'))) {
			return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, prop(entry, depth + 1)]));
		}
		return inert(item);
	};

	const node = (item: unknown, path: string, depth: number): TreeNode | undefined => {
		if (typeof item !== 'object' || item === null || Array.isArray(item)) {
			problems.push(`${path || 'The root'} is not a node.`);
			return undefined;
		}
		const { type, props, children, key } = item as Record<string, unknown>;
		if (typeof type !== 'string' || !allowed.has(type)) {
			problems.push(`${path || 'The root'} uses "${String(type)}", which widgets cannot draw (only ${limits.components.join(', ')}).`);
			return undefined;
		}
		if (++count > limits.maxNodes) {
			problems.push(`The widget drew more than ${limits.maxNodes} nodes.`);
			return undefined;
		}
		if (depth > 20) {
			problems.push(`${path} is nested too deeply.`);
			return undefined;
		}
		const out: TreeNode = { type };
		if (typeof key === 'string' || typeof key === 'number') {
			out.key = String(key);
		}
		if (props !== undefined) {
			if (typeof props !== 'object' || props === null || Array.isArray(props)) {
				problems.push(`${path || 'The root'} has props that are not an object.`);
			} else {
				out.props = prop(props, 0) as TreeNode['props'];
			}
		}
		if (typeof children === 'string') {
			out.children = children;
		} else if (Array.isArray(children)) {
			out.children = children.map((child, i) => node(child, `${path}/children/${i}`, depth + 1)).filter((child): child is TreeNode => child !== undefined);
		} else if (children !== undefined && children !== null) {
			problems.push(`${path || 'The root'} has children that are neither text nor nodes.`);
		}
		return out;
	};

	const tree = node(value, '', 0);
	return tree ? { tree, problems } : { problems };
}

/** The initial state of a widget: its `state` prop, as inert data. */
export function initialState(props: WidgetProps): unknown {
	return inert(props.state ?? null);
}

/** The arguments `render` is called with. */
export const renderArgs = (props: WidgetProps, state: unknown): unknown[] => [inert(props.input ?? null), state];

/** The arguments `update` is called with. */
export const updateArgs = (props: WidgetProps, state: unknown, event: WidgetEvent): unknown[] => [state, event.$event, inert(event.payload ?? null), inert(props.input ?? null)];

/** Reads a widget node's evaluated props. */
export function widgetProps(props: Record<string, unknown>): WidgetProps | undefined {
	if (typeof props.render !== 'string') {
		return undefined;
	}
	return {
		render: props.render,
		...(typeof props.update === 'string' ? { update: props.update } : {}),
		...(props.input !== undefined ? { input: props.input } : {}),
		...(props.state !== undefined ? { state: props.state } : {}),
	};
}

/** The row of a widget's input a use refers to, by id; undefined when it names none. */
export function widgetRow(input: unknown, ref: unknown): Record<string, unknown> | undefined {
	const id = typeof ref === 'object' && ref !== null ? (ref as { id?: unknown }).id : ref;
	if (typeof id !== 'string' && typeof id !== 'number') {
		return undefined;
	}
	const rows = Array.isArray(input) ? input : [];
	return rows.find((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && (row as { id?: unknown }).id === id);
}

export interface ResolvedUse {
	/** The declared action, evaluated for the row. */
	action?: Action;
	row?: Record<string, unknown>;
	available: boolean;
	/** Why it is not available, when that is the code's doing. */
	problem?: string;
}

/**
 * Resolves a use against the widget's declared actions (unevaluated) and
 * its input: the row must be one of the input's rows (matched by id, so a
 * copy the code made cannot change it), and the action is the declared
 * `$call` evaluated for that row, offered only if its `visible` holds.
 */
export function resolveWidgetUse(use: WidgetUse, actions: unknown, input: unknown, ctx: EvalContext): ResolvedUse {
	const declared = typeof actions === 'object' && actions !== null && Object.hasOwn(actions, use.$use) ? (actions as Record<string, WidgetAction>)[use.$use] : undefined;
	if (!declared) {
		return { available: false, problem: `The widget offers "${use.$use}", which it does not declare.` };
	}
	const row = widgetRow(input, use.row);
	if (!row) {
		return { available: false, problem: `The widget offers "${use.$use}" on a row that is not in its input.` };
	}
	const rowCtx = { ...ctx, row };
	const action = evaluate(declared.call, rowCtx);
	const visible = declared.visible === undefined || evaluate(declared.visible, rowCtx) === true;
	return isAction(action) ? { action, row, available: visible } : { row, available: false, problem: `The widget's "${use.$use}" is not a $call.` };
}
