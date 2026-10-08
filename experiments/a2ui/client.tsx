import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import apiFetch from '@wordpress/api-fetch';
import { Button, Notice, Spinner } from '@wordpress/components';
import {
	A2UIProcessor,
	A2UIRenderer,
	createCatalog,
	joinPointer,
	resolveBoolean,
	useProcessor,
	useScopePath,
	useSurface,
	type A2UIComponentProps,
	type ActionMessage,
	type JsonValue,
} from '../../../swissspidy/a2ui-wp/src/index.ts';
import { removeRow } from '../../packages/core/src/build/rows.ts';
import { createCan } from '../../hosts/wordpress/adapter/src/can.ts';
import { cell, readPath, type Field } from '../../hosts/wordpress/adapter/src/cells.ts';
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

/** The Graft Table, a catalog component A2UI's basic catalog does not have. */
function Table({ id, props }: A2UIComponentProps<{ rows?: { path: string }; fields?: Field[]; rowActions?: RowAction[]; empty?: string }>) {
	const processor = useProcessor();
	const surface = useSurface();
	const scopePath = useScopePath();
	const rowsPath = props.rows?.path ? joinPointer(scopePath, props.rows.path) : undefined;
	const rows = rowsPath ? surface.dataModel.get(rowsPath) : undefined;
	const fields = props.fields ?? [];
	const primary = fields.find((field) => field.primary) ?? fields[0];
	if (!Array.isArray(rows)) {
		return <Spinner />;
	}
	if (rows.length === 0) {
		return <p>{props.empty ?? 'No items.'}</p>;
	}
	return (
		<table className="wp-list-table widefat fixed striped">
			<thead>
				<tr>
					{fields.map((field) => (
						<th key={field.id} scope="col">
							{field.label}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((row, i) => {
					const rowPath = joinPointer(rowsPath, String(i));
					// `can` for this row: the host check refines per post.
					const scope = { ...processor.createScope(surface, rowPath), functions: { ...processor.functions, can: (args: Record<string, unknown>) => can(String(args.scope), row) } };
					const actions = (props.rowActions ?? []).filter((action) => action.visible === undefined || resolveBoolean(action.visible, scope));
					return (
						<tr key={String(readPath(row, 'id') ?? i)}>
							{fields.map((field) => (
								<td key={field.id}>
									{field === primary ? <strong>{cell(field, row, () => undefined, 'en-US').text}</strong> : cell(field, row, () => undefined, 'en-US').text}
									{field === primary && actions.length > 0 && (
										<div>
											{actions.map((action) => (
												<Button key={action.id} variant={action.variant === 'primary' ? 'primary' : 'secondary'} size="compact" data-graft-action={action.id} onClick={() => processor.dispatchAction(surface.id, id, action.action, rowPath)}>
													{action.label}
												</Button>
											))}
										</div>
									)}
								</td>
							))}
						</tr>
					);
				})}
			</tbody>
		</table>
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
