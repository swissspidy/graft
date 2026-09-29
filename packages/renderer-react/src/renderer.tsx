import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { evaluate, functionKey, isAction, removeRow, type Action, type AsyncFunctionRunner, type Build, type EvalContext, type FunctionCall, type TreeNode, type Value } from '@graft/core/runtime';

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
}

interface RuntimeValue {
	ctx: EvalContext;
	invoke(action: unknown): Promise<void>;
	components: ComponentRegistry;
}

const Runtime = createContext<RuntimeValue | null>(null);

/**
 * Loads the build's data sources through the gateway and renders its tree
 * with the host's components. Unknown component types render nothing: the
 * build was validated against the surface, so this only happens if the
 * registry and the surface disagree.
 */
export function GraftRoot({ build, components, gateway, slot = {}, can, onNotice, onReload, functions }: GraftRootProps) {
	const [data, setData] = useState<Record<string, unknown>>({});
	const fn = useFunctions(build.code ? functions : undefined);
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

	const runtime = useMemo<RuntimeValue>(() => ({ ctx: { data, slot, can, fn }, invoke, components }), [data, slot, can, fn, invoke, components]);

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
function useFunctions(factory: (() => AsyncFunctionRunner) | undefined): EvalContext['fn'] {
	const runner = useRef<AsyncFunctionRunner | undefined>(undefined);
	const results = useRef(new Map<string, unknown>());
	const queued = useRef(new Map<string, FunctionCall>());
	const inFlight = useRef(new Set<string>());
	const [version, setVersion] = useState(0);

	useEffect(() => () => runner.current?.dispose?.(), []);

	useEffect(() => {
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
	});

	return useMemo(() => {
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
}

function errorMessage(error: unknown): string {
	if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
		return (error as { message: string }).message;
	}
	return 'Something went wrong.';
}
