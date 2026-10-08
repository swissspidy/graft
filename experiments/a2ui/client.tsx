import { useState } from 'react';
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
	useProcessor,
	useScopePath,
	useSurface,
	type A2UIComponentProps,
	type ActionMessage,
	type JsonValue,
} from '../../../swissspidy/a2ui-wp/src/index.ts';
import { removeRow } from '../../packages/core/src/build/rows.ts';
import { createCan } from '../../hosts/wordpress/adapter/src/can.ts';
import type { Field } from '../../hosts/wordpress/adapter/src/cells.ts';
import { components } from '../../hosts/wordpress/adapter/src/client/components.tsx';
import { withContext } from './events.ts';
import type { A2UIBuild } from './snapshot.ts';

/**
 * Proof of concept: renders an A2UI build in wp-admin with a2ui-wp's
 * renderer and catalog, plus a Graft Table. The Graft runtime plays the
 * A2UI server without an agent: it fills the data model from the build's
 * data sources and answers action events with capability calls, all
 * through the Graft gateway (/graft/v1/call), as the tree runtime does.
 */

declare global {
	interface Window {
		graftA2UI: { spec: string; build: A2UIBuild; scopes: Record<string, boolean> };
	}
}

const { spec, build, scopes } = window.graftA2UI;
const can = createCan(scopes);
const surfaceId = 'main';
const version = build.ui.protocol.replace(/^a2ui\//, '');

const call = (capability: string, input: unknown) => apiFetch<JsonValue>({ path: '/graft/v1/call', method: 'POST', data: { spec, capability, input } });

const processor = new A2UIProcessor({ supportedCatalogIds: [build.ui.catalogId], locale: 'en-US' });
processor.processMessages([
	{ version, createSurface: { surfaceId, catalogId: build.ui.catalogId } },
	{ version, updateComponents: { surfaceId, components: build.ui.components } },
]);

const data: Record<string, unknown> = {};
const load = async (names: string[]) => {
	await Promise.all(
		names.map(async (name) => {
			data[name] = await call(build.data[name]!.call, build.data[name]!.input ?? {});
			processor.processMessage({ version, updateDataModel: { surfaceId, path: `/${name}`, value: data[name] as JsonValue } });
		}),
	);
};

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
	const scopePath = useScopePath();
	const rowsPath = props.rows?.path ? joinPointer(scopePath, props.rows.path) : undefined;
	const rows = rowsPath ? surface.dataModel.get(rowsPath) : undefined;
	const list = Array.isArray(rows) ? rows : undefined;

	const evaluate = (value: unknown, row?: unknown): unknown => {
		if (row === undefined || !list) {
			return value;
		}
		const path = joinPointer(rowsPath, String(list.indexOf(row)));
		// `can` for this row: the host check refines per post.
		const scope = { ...processor.createScope(surface, path), functions: { ...processor.functions, can: (args: Record<string, unknown>) => can(String(args.scope), row) } };
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
		processor.dispatchAction(surface.id, id, action, path);
	};

	return (
		<GraftTable
			node={{ type: 'table' }}
			props={{ rows: list, fields: props.fields, empty: props.empty }}
			raw={{ fields: (props.fields ?? []) as never, actions: (props.rowActions ?? []) as never }}
			evaluate={evaluate as never}
			invoke={invoke}
		>
			{null}
		</GraftTable>
	);
}

const catalog = createCatalog({ Table });

function Page() {
	const [notice, setNotice] = useState<{ status: 'success' | 'error'; text: string }>();
	// An action event: call the capability it is bound to, then apply its `then`.
	const onAction = async ({ action }: ActionMessage) => {
		const binding = build.events[action.name];
		if (!binding) {
			setNotice({ status: 'error', text: `Unknown action "${action.name}".` });
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
		<>
			{notice && (
				<Notice status={notice.status} onRemove={() => setNotice(undefined)}>
					{notice.text}
				</Notice>
			)}
			<A2UIRenderer processor={processor} catalog={catalog} onAction={onAction} />
		</>
	);
}

createRoot(document.getElementById('graft-a2ui')!).render(<Page />);
void load(Object.keys(build.data));
