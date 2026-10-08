import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import {
	evaluate,
	functionKey,
	initialState,
	inputEvent,
	inputValues,
	isAction,
	isWidgetEvent,
	removeRow,
	renderArgs,
	resolveWidgetUse,
	sanitizeWidgetTree,
	updateArgs,
	WIDGET,
	widgetInputs,
	widgetProps,
	type Action,
	type AsyncFunctionRunner,
	type Build,
	type EvalContext,
	type FunctionCall,
	type TreeNode,
	type Value,
	type WidgetEvent,
	type WidgetLimits,
} from '@graft/core/runtime';

export { removeRow };

/** Runs capability calls for a rendered build; the host enforces the grant. */
export interface Gateway {
	call(capability: string, input: unknown): Promise<unknown>;
}

export interface RendererComponentProps {
	/** Props evaluated in the node's context (no current row). */
	props: Record<string, unknown>;
	/** Raw props, for components that evaluate some per row (table actions). */
	raw: Record<string, Value>;
	/** Evaluates a raw value, optionally for a row. */
	evaluate(value: Value | undefined, row?: unknown): unknown;
	/** Runs an evaluated action (from a `$call`). */
	invoke(action: unknown): Promise<void>;
	/** Rendered children, or text for text components. */
	children?: ReactNode;
	node: TreeNode;
	/**
	 * For an input component in a widget: what it shows, and how to change
	 * it. The host keeps the value; the component only displays it.
	 */
	field?: { value: unknown; change(value: unknown): void };
}

export type ComponentRegistry = Record<string, ComponentType<RendererComponentProps>>;

export interface Notice {
	status: 'success' | 'error';
	message: string;
}

export interface GraftRootProps {
	build: Build;
	components: ComponentRegistry;
	gateway: Gateway;
	/** Props the slot provides, e.g. the current post. */
	slot?: Record<string, unknown>;
	/** Host permission check behind `$can`. */
	can: EvalContext['can'];
	onNotice?(notice: Notice): void;
	/** Called for `reload:page`. */
	onReload?(): void;
	/**
	 * Runs the build's functions (`$fn`), off the main thread. Only needed,
	 * and only started, when the build has code.
	 */
	functions?: () => AsyncFunctionRunner;
	/** What interactive widgets may draw with; without it, widgets draw nothing. */
	widgets?: WidgetLimits;
	/** Draws a build without a tree (another UI format); without it, such a build draws nothing. */
	ui?: ComponentType<UiRootProps>;
}

/**
 * What a renderer for another UI format gets: the loaded data sources, and
 * `invoke` for the actions its events resolve to, so `then`, notices and
 * reloads work exactly as for a tree.
 */
export interface UiRootProps {
	build: Build;
	/** Data sources by name, as they load and change. */
	data: Record<string, unknown>;
	slot: Record<string, unknown>;
	can: EvalContext['can'];
	invoke(action: Action): Promise<void>;
}

interface RuntimeValue {
	ctx: EvalContext;
	invoke(action: unknown): Promise<void>;
	components: ComponentRegistry;
	widgets?: WidgetLimits;
	/** Sends queued function calls to the runner. */
	flush(): void;
	/** Inside a widget: the value an input shows and how to change it, by input id. */
	field?(id: string): RendererComponentProps['field'];
}

const Runtime = createContext<RuntimeValue | null>(null);

/**
 * Loads the build's data sources through the gateway and renders its tree
 * with the host's components. Unknown component types render nothing: the
 * build was validated against the surface, so this only happens if the
 * registry and the surface disagree.
 */
export function GraftRoot({ build, components, gateway, slot = {}, can, onNotice, onReload, functions, widgets, ui: Ui }: GraftRootProps) {
	const [data, setData] = useState<Record<string, unknown>>({});
	const { fn, flush } = useFunctions(build.code ? functions : undefined);
	const mounted = useRef(true);
	useEffect(() => () => void (mounted.current = false), []);

	const load = useCallback(
		async (names: string[]) => {
			const base: EvalContext = { data: {}, slot, can };
			await Promise.all(
				names.map(async (name) => {
					const source = build.data[name];
					if (!source) {
						return;
					}
					try {
						const result = await gateway.call(source.call, evaluate(source.input, base) ?? null);
						if (mounted.current) {
							setData((current) => ({ ...current, [name]: result }));
						}
					} catch (error) {
						onNotice?.({ status: 'error', message: errorMessage(error) });
					}
				}),
			);
		},
		// The build and slot are fixed for the lifetime of a root.
		[build, gateway],
	);

	useEffect(() => {
		void load(Object.keys(build.data));
	}, [build, load]);

	const invoke = useCallback(
		async (value: unknown) => {
			if (!isAction(value)) {
				return;
			}
			const action: Action = value;
			try {
				await gateway.call(action.capability, action.input ?? null);
			} catch (error) {
				onNotice?.({ status: 'error', message: errorMessage(error) });
				return;
			}
			if (action.notice) {
				onNotice?.({ status: 'success', message: action.notice });
			}
			const refresh: string[] = [];
			for (const op of action.then) {
				const [kind, target = ''] = op.split(':');
				if (kind === 'refresh') {
					refresh.push(target);
				} else if (kind === 'remove-row' && action.row !== undefined) {
					setData((current) => ({ ...current, [target]: removeRow(current[target], action.row) }));
				} else if (kind === 'reload') {
					onReload?.();
				}
			}
			if (refresh.length > 0) {
				await load(refresh);
			}
		},
		[gateway, load, onNotice, onReload],
	);

	const runtime = useMemo<RuntimeValue>(
		() => ({ ctx: { data, slot, can, fn }, invoke, components, flush, ...(widgets ? { widgets } : {}) }),
		[data, slot, can, fn, invoke, components, flush, widgets],
	);

	if (!build.tree) {
		return Ui ? <Ui build={build} data={data} slot={slot} can={can} invoke={invoke} /> : null;
	}
	return (
		<Runtime.Provider value={runtime}>
			<Node node={build.tree} />
		</Runtime.Provider>
	);
}

function Node({ node }: { node: TreeNode }) {
	const runtime = useContext(Runtime);
	if (!runtime) {
		return null;
	}
	if (node.type === WIDGET) {
		return <Widget node={node} />;
	}
	const Component = runtime.components[node.type];
	if (!Component) {
		return null;
	}
	const raw = (node.props ?? {}) as Record<string, Value>;
	const props = evaluate(raw, runtime.ctx) as Record<string, unknown>;
	const children =
		typeof node.children === 'string'
			? node.children
			: node.children?.map((child, i) => <Node key={child.key ?? i} node={child} />);
	return (
		<Component
			node={node}
			props={props}
			raw={raw}
			evaluate={(value, row) => evaluate(value, row === undefined ? runtime.ctx : { ...runtime.ctx, row })}
			invoke={runtime.invoke}
			{...(runtime.field && typeof props.id === 'string' && runtime.widgets?.inputs?.includes(node.type) ? { field: runtime.field(props.id) } : {})}
		>
			{children}
		</Component>
	);
}

/**
 * `$fn` for a render. Results are cached by function and arguments (the
 * functions are pure). A call without a result yet evaluates to undefined
 * and is queued; after the render, queued calls go to the runner in one
 * batch, and the tree renders again with their results. A failed call
 * shows as null.
 */
function useFunctions(factory: (() => AsyncFunctionRunner) | undefined): { fn: EvalContext['fn']; flush(): void } {
	const runner = useRef<AsyncFunctionRunner | undefined>(undefined);
	const results = useRef(new Map<string, unknown>());
	const queued = useRef(new Map<string, FunctionCall>());
	const inFlight = useRef(new Set<string>());
	const [version, setVersion] = useState(0);

	useEffect(() => () => runner.current?.dispose?.(), []);

	const flush = useCallback(() => {
		if (!factory || queued.current.size === 0) {
			return;
		}
		const batch = [...queued.current];
		queued.current.clear();
		batch.forEach(([key]) => inFlight.current.add(key));
		runner.current ??= factory();
		void runner.current.call(batch.map(([, call]) => call)).then((out) => {
			batch.forEach(([key], i) => {
				const result = out[i];
				results.current.set(key, result?.ok ? result.value : null);
				inFlight.current.delete(key);
			});
			setVersion((v) => v + 1);
		});
	}, [factory]);

	useEffect(flush);

	const fn = useMemo(() => {
		if (!factory) {
			return undefined;
		}
		return (name: string, args: unknown[]) => {
			const key = functionKey(name, args);
			if (results.current.has(key)) {
				return results.current.get(key);
			}
			if (!inFlight.current.has(key)) {
				queued.current.set(key, { name, args });
			}
			return undefined;
		};
		// A new function per result batch, so the tree re-evaluates.
	}, [factory, version]);
	return { fn, flush };
}

/**
 * An interactive widget. Its render function draws a tree of the host's
 * components from its input and state; the tree is sanitized (allow-listed
 * components, inert props) and drawn by the host's own components. Its
 * buttons can only send events: `update` computes the next state, and
 * nothing reaches the gateway.
 */
function Widget({ node }: { node: TreeNode }) {
	const runtime = useContext(Runtime);
	const props = runtime ? widgetProps(evaluate((node.props ?? {}) as Record<string, Value>, runtime.ctx) as Record<string, unknown>) : undefined;
	const [state, setState] = useState<unknown>(() => (props ? initialState(props) : null));
	// Events wait in order: each one updates the state the previous one left.
	const [pending, setPending] = useState<WidgetEvent[]>([]);
	const event = pending[0];
	const fn = runtime?.ctx.fn;

	// Functions are pure and cached, so these return undefined until their result arrives.
	const next = props?.update && event && fn ? fn(props.update, updateArgs(props, state, event)) : undefined;
	const drawn = props && fn ? fn(props.render, renderArgs(props, state)) : undefined;

	useEffect(() => {
		runtime?.flush();
		if (event && next !== undefined) {
			setState(next);
			setPending((events) => events.slice(1));
		}
	});

	const tree = useMemo(() => (drawn !== undefined && drawn !== null && runtime?.widgets ? sanitizeWidgetTree(drawn, runtime.widgets).tree : undefined), [drawn, runtime?.widgets]);
	// What the viewer entered in the widget's inputs. Inputs show it, else what the code drew;
	// declared actions read the same values ($input), so they send what is on screen.
	const [entered, setEntered] = useState<Record<string, unknown>>({});
	const inputs = useMemo(() => (tree && runtime?.widgets ? widgetInputs(tree, runtime.widgets) : {}), [tree, runtime?.widgets]);
	const values = useMemo(() => inputValues(inputs, entered), [inputs, entered]);

	const inner = useMemo<RuntimeValue | undefined>(() => {
		if (!runtime) {
			return undefined;
		}
		const actions = ((node.props ?? {}) as Record<string, Value>).actions;
		return {
			...runtime,
			ctx: {
				...runtime.ctx,
				// A use of a declared action becomes the action for that row of the input, or null.
				use: (use) => {
					const resolved = resolveWidgetUse(use, actions, props?.input, { ...runtime.ctx, inputs: values });
					return resolved.available && resolved.action ? resolved.action : null;
				},
			},
			field: (id) => {
				const input = inputs[id];
				if (!input) {
					return undefined;
				}
				return {
					value: values[id],
					change: (value) => {
						setEntered((current) => ({ ...current, [id]: value }));
						const event = inputEvent(input, value);
						if (event) {
							setPending((events) => [...events, event]);
						}
					},
				};
			},
			// Inside a widget, only its own events and its resolved actions do anything; any
			// $call the code drew was made null by the sanitizer.
			invoke: async (value: unknown) => {
				if (isWidgetEvent(value)) {
					setPending((events) => [...events, value]);
				} else if (isAction(value)) {
					await runtime.invoke(value);
				}
			},
		};
	}, [runtime, node, props?.input, inputs, values]);

	if (!tree || !inner) {
		return null;
	}
	return (
		<Runtime.Provider value={inner}>
			<div data-graft-widget="" aria-busy={pending.length > 0 ? true : undefined}>
				<Node node={tree} />
			</div>
		</Runtime.Provider>
	);
}

function errorMessage(error: unknown): string {
	if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
		return (error as { message: string }).message;
	}
	return 'Something went wrong.';
}
