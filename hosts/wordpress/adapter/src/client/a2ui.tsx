import { createContext, useContext, useEffect, useMemo } from 'react';
import { pureFunctions, tableField, withContext, type A2UIBuild } from '@graft/a2ui/client';
import {
	A2UIProcessor,
	A2UIRenderer,
	createCatalog,
	joinPointer,
	resolveBoolean,
	resolveDynamicValue,
	useDynamicBoolean,
	useDynamicString,
	useProcessor,
	useScopePath,
	useSurface,
	wordPressCatalog,
	type A2UIComponentProps,
	type ActionMessage,
	type ComponentCatalog,
	type FunctionRegistry,
	type JsonValue,
	type ResolveScope,
} from 'a2ui-wp';
import type { UiRootProps } from '@graft/renderer-react';
import type { Field } from '../cells.ts';
import { components } from './components.tsx';

/**
 * Draws an A2UI build with a2ui-wp's renderer (@wordpress/components), for
 * GraftRoot: it gets the build's data sources as they load and `invoke`
 * for the actions its events resolve to, so data loading, the gateway,
 * `then`, notices and reloads are the tree runtime's own. The Graft runtime
 * plays the A2UI server: the data model is filled from the data sources,
 * and an action event becomes the capability call it is bound to.
 */

export const surfaceId = 'graft';

/** The viewer's permission check, for tables to refine per row. */
const CanContext = createContext<UiRootProps['can']>(() => false);

/**
 * The catalog's functions in a2ui-wp's form. The pure ones are shared with
 * the verifier (@graft/a2ui); `can` and `set` need the live surface.
 */
function functionsFor(can: UiRootProps['can'], set: (pointer: string, value: unknown) => void): FunctionRegistry {
	const registry: FunctionRegistry = { ...pureFunctions(new Date()) };
	registry.can = (args) => can(String(args.scope), args.on);
	registry.set = (args) => set(String(args.target), args.value);
	return registry;
}

interface RowAction {
	id: string;
	label: string;
	variant?: string;
	visible?: unknown;
	action: { event: { name: string; context?: Record<string, unknown> } };
}

const GraftTable = components.table!;
const isRowAction = (value: unknown): value is RowAction => typeof value === 'object' && value !== null && 'action' in value && 'label' in value;

/**
 * The catalog's Table: Graft's own WordPress table, so trees and A2UI
 * surfaces draw rows, cells and actions identically. Its `evaluate`
 * resolves the A2UI definitions in each row's scope; a row action
 * dispatches its A2UI event.
 */
function Table({ id, props }: A2UIComponentProps<{ rows?: { path: string }; fields?: Field[]; rowActions?: RowAction[]; empty?: unknown }>) {
	const processor = useProcessor();
	const surface = useSurface();
	const can = useContext(CanContext);
	const scopePath = useScopePath();
	const rowsPath = props.rows?.path ? joinPointer(scopePath, props.rows.path) : undefined;
	const rows = rowsPath ? surface.dataModel.get(rowsPath) : undefined;
	const list = Array.isArray(rows) ? rows : undefined;
	// Field ids are JSON Pointers into the row: Graft's table reads them as bindings.
	const fields = (props.fields ?? []).map(tableField);

	const evaluate = (value: unknown, row?: unknown): unknown => {
		if (row === undefined || !list) {
			return value;
		}
		const path = joinPointer(rowsPath, String(list.indexOf(row)));
		// `can` in a row refines on the row's post.
		const scope = { ...processor.createScope(surface, path), functions: { ...processor.functions, can: (args: Record<string, unknown>) => can(String(args.scope), args.on ?? row) } };
		if (isRowAction(value)) {
			return {
				id: value.id,
				label: value.label,
				primary: value.variant === 'primary',
				visible: value.visible === undefined || resolveBoolean(value.visible, scope),
				onClick: { action: value.action, path },
			};
		}
		return resolveDynamicValue(value, scope);
	};
	const invoke = async (onClick: unknown) => {
		const { action, path } = onClick as { action: RowAction['action']; path: string };
		processor.dispatchAction(surface.id, id, action as Parameters<typeof processor.dispatchAction>[2], path);
	};

	return (
		<GraftTable
			node={{ type: 'table' }}
			props={{ rows: list, fields, empty: props.empty === undefined ? undefined : String(resolveDynamicValue(props.empty, processor.createScope(surface, scopePath)) ?? '') }}
			raw={{ fields: fields as never, actions: (props.rowActions ?? []) as never }}
			evaluate={evaluate as never}
			invoke={invoke}
		>
			{null}
		</GraftTable>
	);
}

const BaseButton = wordPressCatalog.Button!;

/**
 * a2ui-wp's Button, marked with its action id (`actionId`, else its
 * component id) as Graft's own buttons and row actions are.
 */
function Button(props: A2UIComponentProps<{ actionId?: unknown }>) {
	const actionId = useDynamicString(props.props.actionId ?? '') || props.id;
	return (
		<span data-graft-action={actionId}>
			<BaseButton {...props} />
		</span>
	);
}

/** The catalog's `visible`, on every component: false draws nothing. */
const withVisible = (catalog: ComponentCatalog): ComponentCatalog =>
	Object.fromEntries(
		Object.entries(catalog).map(([name, Component]) => [
			name,
			(props: A2UIComponentProps<{ visible?: unknown }>) => (useDynamicBoolean(props.props.visible ?? true) ? <Component {...props} /> : null),
		]),
	);

const catalog = withVisible(createCatalog({ ...wordPressCatalog, Button, Table }));

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Resolves a value as the verifier (@a2ui/web_core) does: bindings and calls
 * anywhere in plain objects and lists, e.g. `{"form": {"title": {"path": "/slot/post/title"}}}`.
 * a2ui-wp passes a literal object through untouched.
 */
function resolveDeep(value: unknown, scope: ResolveScope): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => resolveDeep(item, scope));
	}
	if (isPlainObject(value) && !('path' in value) && !('call' in value)) {
		return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, resolveDeep(inner, scope)]));
	}
	return resolveDynamicValue(value, scope);
}

/** Values of an A2UI `initial` or `computed` section, written into the model in order. */
function seed(processor: A2UIProcessor, values: Record<string, unknown> | undefined) {
	const surface = processor.getSurface(surfaceId);
	if (!surface) {
		return;
	}
	for (const [key, value] of Object.entries(values ?? {})) {
		// A copy: what the viewer enters must not write into the build's own values.
		surface.dataModel.set(`/${key}`, structuredClone(resolveDeep(value, processor.createScope(surface, '/')) ?? null) as JsonValue);
	}
}

/**
 * The A2UI processor for one mounted build: its components, the slot, then
 * `initial`; `computed` follows every change of the model. `set`, the
 * catalog's local action, writes the model.
 */
export function createProcessor(build: A2UIBuild, slot: Record<string, unknown>, can: UiRootProps['can']): A2UIProcessor {
	const version = build.ui.protocol.replace(/^a2ui\//, '');
	const set = (pointer: string, value: unknown) => processor.getSurface(surfaceId)?.dataModel.set(pointer, (value ?? null) as JsonValue);
	const processor: A2UIProcessor = new A2UIProcessor({ supportedCatalogIds: [build.ui.catalogId], locale: 'en-US', functions: functionsFor(can, set) });
	processor.processMessages([
		{ version, createSurface: { surfaceId, catalogId: build.ui.catalogId } },
		{ version, updateComponents: { surfaceId, components: build.ui.components as never } },
		{ version, updateDataModel: { surfaceId, path: '/slot', value: slot as JsonValue } },
	]);
	seed(processor, build.ui.initial);
	let computing = false;
	const recompute = () => {
		if (computing || !build.ui.computed) {
			return;
		}
		computing = true;
		try {
			seed(processor, build.ui.computed);
		} finally {
			computing = false;
		}
	};
	processor.getSurface(surfaceId)?.dataModel.subscribe(recompute);
	recompute();
	return processor;
}

/** Draws an A2UI build for GraftRoot (its `ui`). */
export function A2UIRoot({ build: raw, data, slot, can, invoke }: UiRootProps) {
	const build = raw as unknown as A2UIBuild;
	const version = build.ui.protocol.replace(/^a2ui\//, '');

	// The build, slot and viewer are fixed for the lifetime of a root.
	const processor = useMemo(() => createProcessor(build, slot, can), []);

	// Data sources into the model, as they load and change.
	useEffect(() => {
		for (const [name, value] of Object.entries(data)) {
			processor.processMessage({ version, updateDataModel: { surfaceId, path: `/${name}`, value: (value ?? null) as JsonValue } });
		}
	}, [data, processor, version]);

	// An action event: the capability call it is bound to, run as a tree's action would be.
	const onAction = async ({ action }: ActionMessage) => {
		const binding = build.events[action.name];
		if (!binding) {
			console.warn(`Graft: the action event "${action.name}" is not bound.`);
			return;
		}
		const context = (action.context ?? {}) as Record<string, unknown>;
		await invoke({
			$action: true,
			capability: binding.call,
			input: withContext(binding.input ?? {}, context),
			then: binding.then ?? [],
			...(binding.notice ? { notice: binding.notice } : {}),
			// remove-row matches by id; the event's context carries it.
			row: context,
		});
	};

	return (
		<CanContext.Provider value={can}>
			<A2UIRenderer processor={processor} catalog={catalog} onAction={onAction} />
		</CanContext.Provider>
	);
}

// The runtime (mount.tsx) draws A2UI builds with this.
window.graftUi = { ...window.graftUi, A2UI: A2UIRoot };
