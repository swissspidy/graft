import { useEffect, useMemo } from 'react';
import { createGraftCatalog, seed, tableField, withContext, type A2UIBuild } from '@graft/a2ui/client';
import {
	A2UIProcessor,
	A2UIRenderer,
	createCatalog,
	useDynamicBoolean,
	useDynamicString,
	useProcessor,
	useScopePath,
	useSurface,
	wordPressCatalog,
	type A2UIComponentProps,
	type ActionMessage,
	type ComponentCatalog,
} from '@swissspidy/a2ui-wp';
import type { UiRootProps } from '@graft/renderer-react';
import type { Field } from '../cells.ts';
import { components } from './components.tsx';

/**
 * Draws an A2UI build with a2ui-wp (@wordpress/components on
 * @a2ui/web_core), for GraftRoot: it gets the build's data sources as they
 * load and `invoke` for the actions its events resolve to, so data
 * loading, the gateway, `then`, notices and reloads are the tree runtime's
 * own. The Graft runtime plays the A2UI server: the data model is filled
 * from the data sources, and an action event becomes the capability call it
 * is bound to.
 *
 * The surface uses the same Graft catalog as the verifier (@graft/a2ui):
 * the same functions, resolved by the same web_core, so what the checks
 * proved is what the viewer gets. `can` refines on the row in scope, and
 * `set` writes the surface's data model through A2UI's own data context.
 */

export const surfaceId = 'graft';
const VERSION = 'v0.9';

interface RowAction {
	id: string;
	label: string;
	variant?: string;
	visible?: unknown;
	action: unknown;
}

const GraftTable = components.table!;
const isRowAction = (value: unknown): value is RowAction => typeof value === 'object' && value !== null && 'action' in value && 'label' in value;

/**
 * The catalog's Table: Graft's own WordPress table, so trees and A2UI
 * surfaces draw rows, cells and actions identically. Its `evaluate`
 * resolves the A2UI definitions in each row's scope; a row action
 * dispatches its A2UI action (an event, or a local `set`).
 */
function Table({ id, props }: A2UIComponentProps<{ rows?: { path: string }; fields?: Field[]; rowActions?: RowAction[]; empty?: unknown }>) {
	const processor = useProcessor();
	const surface = useSurface();
	const scope = processor.createScope(surface, useScopePath());
	const rowsScope = props.rows?.path ? scope.nested(props.rows.path) : undefined;
	const rows = rowsScope ? surface.dataModel.get(rowsScope.path) : undefined;
	const list = Array.isArray(rows) ? rows : undefined;
	// Field ids are JSON Pointers into the row: Graft's table reads them as bindings.
	const fields = (props.fields ?? []).map(tableField);

	const evaluate = (value: unknown, row?: unknown): unknown => {
		if (row === undefined || !list || !rowsScope) {
			return value;
		}
		const rowScope = rowsScope.nested(String(list.indexOf(row)));
		if (isRowAction(value)) {
			return {
				id: value.id,
				label: value.label,
				primary: value.variant === 'primary',
				visible: value.visible === undefined || Boolean(rowScope.resolveDynamicValue(value.visible)),
				onClick: { action: value.action, path: rowScope.path },
			};
		}
		return rowScope.resolveDynamicValue(value);
	};
	const invoke = async (onClick: unknown) => {
		const { action, path } = onClick as { action: never; path: string };
		processor.dispatchAction(surface.id, id, action, path);
	};

	return (
		<GraftTable
			node={{ type: 'table' }}
			props={{ rows: list, fields, empty: props.empty === undefined ? undefined : String(scope.resolveDynamicValue(props.empty) ?? '') }}
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

/**
 * The A2UI processor for one mounted build, on the Graft catalog for this
 * viewer: its components, the slot, then `initial`; `computed` follows
 * every change of the model.
 */
export function createProcessor(build: A2UIBuild, slot: Record<string, unknown>, can: UiRootProps['can']): A2UIProcessor {
	const processor = new A2UIProcessor({ locale: 'en-US', catalogs: [createGraftCatalog({ id: build.ui.catalogId, can, now: new Date() })] });
	processor.processMessages([
		{ version: VERSION, createSurface: { surfaceId, catalogId: build.ui.catalogId } },
		{ version: VERSION, updateComponents: { surfaceId, components: build.ui.components } },
		{ version: VERSION, updateDataModel: { surfaceId, path: '/slot', value: slot } },
	]);
	const surface = processor.getSurface(surfaceId)!;
	const root = processor.createScope(surface, '/');
	// The verifier's own seeding: values copied, so what the viewer enters never writes into the build.
	seed(root, build.ui.initial);
	if (build.ui.computed) {
		let computing = false;
		const recompute = () => {
			if (computing) {
				return;
			}
			computing = true;
			try {
				// Only what changed: every write notifies this subscription again.
				for (const [key, expression] of Object.entries(build.ui.computed!)) {
					const value = root.resolveDynamicValue(expression as never);
					if (JSON.stringify(value) !== JSON.stringify(surface.dataModel.get(`/${key}`))) {
						surface.dataModel.set(`/${key}`, structuredClone(value));
					}
				}
			} finally {
				computing = false;
			}
		};
		surface.dataModel.subscribe('/', recompute);
		recompute();
	}
	return processor;
}

/** Draws an A2UI build for GraftRoot (its `ui`). */
export function A2UIRoot({ build: raw, data, slot, can, invoke }: UiRootProps) {
	const build = raw as unknown as A2UIBuild;
	// The build, slot and viewer are fixed for the lifetime of a root.
	const processor = useMemo(() => createProcessor(build, slot, can), []);

	// Data sources into the model, as they load and change.
	useEffect(() => {
		for (const [name, value] of Object.entries(data)) {
			processor.processMessage({ version: VERSION, updateDataModel: { surfaceId, path: `/${name}`, value: value ?? null } });
		}
	}, [data, processor]);

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

	return <A2UIRenderer processor={processor} catalog={catalog} onAction={onAction} />;
}

// The runtime (mount.tsx) draws A2UI builds with this.
window.graftUi = { ...window.graftUi, A2UI: A2UIRoot };
