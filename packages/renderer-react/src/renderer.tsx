import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { evaluate, isAction, removeRow, type Action, type Build, type EvalContext } from '@graft/core/runtime';

export { removeRow };

/** Runs capability calls for a rendered build; the host enforces the grant. */
export interface Gateway {
	call(capability: string, input: unknown): Promise<unknown>;
}

export interface Notice {
	status: 'success' | 'error';
	message: string;
}

export interface GraftRootProps {
	build: Build;
	gateway: Gateway;
	/** Props the slot provides, e.g. the current post. */
	slot?: Record<string, unknown>;
	/** Host permission check behind `$can`. */
	can: EvalContext['can'];
	onNotice?(notice: Notice): void;
	/** Called for `reload:page`. */
	onReload?(): void;
	/** Draws the build's UI (its format's renderer). */
	ui: ComponentType<UiRootProps>;
}

/**
 * What a UI format's renderer gets: the loaded data sources, and `invoke`
 * for the actions its events resolve to, so `then`, notices and reloads
 * work the same in every format.
 */
export interface UiRootProps {
	build: Build;
	/** Data sources by name, as they load and change. */
	data: Record<string, unknown>;
	slot: Record<string, unknown>;
	can: EvalContext['can'];
	invoke(action: Action): Promise<void>;
}

/**
 * Loads the build's data sources through the gateway and draws its UI with
 * the format's renderer, which invokes the actions its events resolve to.
 */
export function GraftRoot({ build, gateway, slot = {}, can, onNotice, onReload, ui: Ui }: GraftRootProps) {
	const [data, setData] = useState<Record<string, unknown>>({});
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

	return <Ui build={build} data={data} slot={slot} can={can} invoke={invoke} />;
}

function errorMessage(error: unknown): string {
	if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
		return (error as { message: string }).message;
	}
	return 'Something went wrong.';
}
