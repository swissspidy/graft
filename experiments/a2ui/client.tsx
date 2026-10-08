import { createContext, useContext, useState, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import apiFetch from '@wordpress/api-fetch';
import { Notice } from '@wordpress/components';
import {
	A2UIProcessor,
	A2UIRenderer,
	createCatalog,
	joinPointer,
	resolveBoolean,
	resolveDynamicValue,
	useDynamicBoolean,
	useProcessor,
	useScopePath,
	useSurface,
	wordPressCatalog,
	type A2UIComponentProps,
	type ComponentCatalog,
	type ActionMessage,
	type JsonValue,
} from '../../packages/a2ui-wp/src/index.ts';
import { removeRow } from '../../packages/core/src/build/rows.ts';
import { createCan } from '../../hosts/wordpress/adapter/src/can.ts';
import type { Field } from '../../hosts/wordpress/adapter/src/cells.ts';
import { components } from '../../hosts/wordpress/adapter/src/client/components.tsx';
import { graftFunctions } from './catalog.ts';
import { withContext } from './events.ts';
import { computeDataModel, initialDataModel, tableField, type A2UIBuild } from './snapshot.ts';

/**
 * Proof of concept: renders an A2UI build in wp-admin with a2ui-wp's
 * renderer and catalog, plus a Graft Table. The Graft runtime plays the
 * A2UI server without an agent: it fills the data model from the build's
 * data sources and answers action events with capability calls, all
 * through the Graft gateway (/graft/v1/call), as the tree runtime does.
 */

declare global {
	interface Window {
		graftA2UI: MountConfig | MountConfig[];
		wp: {
			plugins: { registerPlugin(name: string, settings: { render: () => unknown }): void };
			editor: { PluginDocumentSettingPanel: (props: { name: string; title: string; children: unknown }) => unknown };
			data: { select(store: 'core/editor'): { isEditedPostDirty(): boolean } };
		};
	}
}

interface MountConfig {
	spec: string;
	build: A2UIBuild;
	scopes: Record<string, boolean>;
	slot?: Record<string, unknown>;
	/** In the block editor: the title of the sidebar panel to draw in. */
	panel?: string;
	/** Otherwise: the id of the element to draw in. Default "graft-a2ui". */
	element?: string;
}

const surfaceId = 'main';

/** The viewer's permission check, for tables to refine per row. */
const CanContext = createContext<ReturnType<typeof createCan>>(() => false);

/**
 * One mounted build: its own processor and data model, filled from its data
 * sources through the gateway as that spec, and the page that draws it.
 */
function createMount({ spec, build, scopes, slot, panel }: MountConfig) {
	const can = createCan(scopes);
	const version = build.ui.protocol.replace(/^a2ui\//, '');
	const call = (capability: string, input: unknown) => apiFetch<JsonValue>({ path: '/graft/v1/call', method: 'POST', data: { spec, capability, input } });

	// `set`, the catalog's local action, writes the surface's data model.
	const set = (pointer: string, value: unknown) => processor.getSurface(surfaceId)?.dataModel.set(pointer, (value ?? null) as JsonValue);
	const processor: A2UIProcessor = new A2UIProcessor({ supportedCatalogIds: [build.ui.catalogId], locale: 'en-US', functions: graftFunctions({ can, now: new Date(), set }) });
	processor.processMessages([
		{ version, createSurface: { surfaceId, catalogId: build.ui.catalogId } },
		{ version, updateComponents: { surfaceId, components: build.ui.components } },
	]);
	// The slot at /slot, then `initial` (e.g. a form seeded from the slot), as the verifier sees it.
	const seeded = initialDataModel(build, {}, slot ?? null, (dataModel) => ({ dataModel, functions: processor.functions, locale: 'en-US' })).snapshot();
	processor.processMessage({ version, updateDataModel: { surfaceId, path: '/', value: seeded } });
	// `computed` follows every change of the model (its own writes excepted).
	let computing = false;
	const recompute = () => {
		const dataModel = processor.getSurface(surfaceId)?.dataModel;
		if (computing || !dataModel || !build.ui.computed) {
			return;
		}
		computing = true;
		try {
			computeDataModel(build, dataModel, { dataModel, functions: processor.functions, locale: 'en-US' });
		} finally {
			computing = false;
		}
	};
	processor.getSurface(surfaceId)?.dataModel.subscribe(recompute);
	recompute();

	const data: Record<string, unknown> = {};
	const load = async (names: string[]) => {
		await Promise.all(
			names.map(async (name) => {
				data[name] = await call(build.data[name]!.call, build.data[name]!.input ?? {});
				processor.processMessage({ version, updateDataModel: { surfaceId, path: `/${name}`, value: data[name] as JsonValue } });
			}),
		);
	};

	function Page() {
		const [notice, setNotice] = useState<{ status: 'success' | 'error'; text: string }>();
		// An action event: call the capability it is bound to, then apply its `then`.
		const onAction = async ({ action }: ActionMessage) => {
			const binding = build.events[action.name];
			if (!binding) {
				setNotice({ status: 'error', text: `Unknown action "${action.name}".` });
				return;
			}
			// In the editor, as the tree runtime does: a call that changes the post would be overwritten
			// by the editor's next save, and the reload after it would lose the editor's changes.
			if (panel && window.wp.data.select('core/editor').isEditedPostDirty()) {
				setNotice({ status: 'error', text: 'Save or discard your changes to the post first.' });
				return;
			}
			try {
				await call(binding.call, withContext(binding.input ?? {}, action.context));
			} catch (error) {
				setNotice({ status: 'error', text: (error as Error).message });
				return;
			}
			for (const op of binding.then ?? []) {
				const [kind, target] = op.split(':') as [string, string];
				if (kind === 'reload') {
					window.location.reload();
					return;
				}
				if (kind === 'refresh') {
					await load([target]);
				} else if (kind === 'remove-row') {
					data[target] = removeRow(data[target], action.context);
					processor.processMessage({ version, updateDataModel: { surfaceId, path: `/${target}`, value: data[target] as JsonValue } });
				}
			}
			if (binding.notice) {
				setNotice({ status: 'success', text: binding.notice });
			}
		};
		return (
			<CanContext.Provider value={can}>
				{notice && (
					<Notice status={notice.status} onRemove={() => setNotice(undefined)}>
						{notice.text}
					</Notice>
				)}
				<A2UIRenderer processor={processor} catalog={catalog} onAction={onAction} />
			</CanContext.Provider>
		);
	}

	void load(Object.keys(build.data));
	return Page;
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
 * The Table A2UI's basic catalog lacks: Graft's own WordPress table, so both
 * UI formats draw rows, cells and actions identically. Graft's table asks
 * for each row's actions and cells through `evaluate`; here that resolves
 * the A2UI definitions in the row's scope, and a button dispatches the
 * row's A2UI action event.
 */
function Table({ id, props }: A2UIComponentProps<{ rows?: { path: string }; fields?: Field[]; rowActions?: RowAction[]; empty?: string }>) {
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
		// `can` for this row: the host check refines per post.
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
			props={{ rows: list, fields, empty: props.empty }}
			raw={{ fields: fields as never, actions: (props.rowActions ?? []) as never }}
			evaluate={evaluate as never}
			invoke={invoke}
		>
			{null}
		</GraftTable>
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

const catalog = withVisible(createCatalog({ ...wordPressCatalog, Table }));

for (const config of ([] as MountConfig[]).concat(window.graftA2UI)) {
	const Page = createMount(config);
	if (config.panel) {
		// The post.editor.panel slot: a document settings panel in the block editor's sidebar.
		const Panel = window.wp.editor.PluginDocumentSettingPanel as unknown as ComponentType<{ name: string; title: string; children: ReactNode }>;
		window.wp.plugins.registerPlugin(`graft-a2ui-${config.spec}`, {
			render: () => (
				<Panel name={`graft-a2ui-${config.spec}`} title={config.panel!}>
					<div id="graft-a2ui">
						<Page />
					</div>
				</Panel>
			),
		});
	} else {
		createRoot(document.getElementById(config.element ?? 'graft-a2ui')!).render(<Page />);
	}
}
