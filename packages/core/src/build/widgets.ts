import { inert } from './evaluate.ts';
import type { TreeNode } from './types.ts';

/**
 * Interactive widgets: a `widget` node names two of the build's functions.
 * `render(input, state)` returns a tree of the host's own components, and
 * `update(state, event, payload, input)` returns the next state when the
 * viewer uses one of the tree's `{"$event": name, "payload": ...}` markers.
 *
 * Code never touches the page and never calls a capability: what it
 * returns is sanitized here into inert props on allow-listed components,
 * rendered by the host's trusted components, and its only live values are
 * event markers that lead back to `update`.
 */

/** The component type that hosts a widget. */
export const WIDGET = 'widget';

export interface WidgetEvent {
	$event: string;
	payload?: unknown;
}

export const isWidgetEvent = (value: unknown): value is WidgetEvent =>
	typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { $event?: unknown }).$event === 'string';

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
