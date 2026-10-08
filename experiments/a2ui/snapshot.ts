import { createSnapshotEmitter, type Action, type Build, type EvalContext, type Snapshot, type SnapshotAction } from '../../packages/core/src/index.ts';
import {
	createBasicFunctions,
	DataModel,
	joinPointer,
	resolveBoolean,
	resolveDynamicValue,
	resolveString,
	type ChildList,
	type ComponentDefinition,
	type FunctionRegistry,
	type JsonValue,
	type ResolveScope,
} from '../../../swissspidy/a2ui-wp/src/core/index.ts';
import { cell, readPath, type Field } from '../../hosts/wordpress/adapter/src/cells.ts';
import { withContext } from './events.ts';

/**
 * Proof of concept: a Graft build whose UI is an A2UI v0.9 surface.
 *
 * The Graft envelope (spec, mount, data sources, checks, refs) stays as it
 * is. `ui` holds the A2UI components. A2UI actions are named events; `events`
 * binds each name to a host capability, so no agent is needed at runtime:
 * the Graft runtime plays the A2UI server, filling the data model from the
 * build's data sources and answering events with capability calls.
 */
export interface A2UIBuild extends Omit<Build, 'tree'> {
	ui: { protocol: string; catalogId: string; components: ComponentDefinition[] };
	events: Record<string, { call: string; input?: unknown; then?: string[]; notice?: string }>;
}

interface RowAction {
	id: string;
	label: string;
	visible?: unknown;
	action: { event: { name: string; context?: Record<string, unknown> } };
}

const basic = createBasicFunctions({ locale: 'en-US' });

/**
 * Reads an A2UI surface into the same semantic snapshot a Graft tree gives,
 * with the WordPress catalog: the basic layout and text components, plus a
 * Table (A2UI's basic catalog has none).
 */
export function snapshotA2UI(build: A2UIBuild, ctx: EvalContext): Snapshot {
	const { snapshot, emit } = createSnapshotEmitter();
	const problem = (text: string) => (snapshot.problems ??= []).push(text);
	const components = new Map(build.ui.components.map((component) => [component.id, component]));
	const dataModel = new DataModel(ctx.data as JsonValue);

	// `can` is a catalog function: the host's permission check, for the row in scope.
	const scope = (scopePath?: string, row?: unknown): ResolveScope => {
		const functions: FunctionRegistry = { ...basic, can: (args) => ctx.can(String(args.scope), row) };
		return { dataModel, functions, scopePath, locale: 'en-US' };
	};

	const event = (action: RowAction['action'], at: ResolveScope, row: unknown): Action | undefined => {
		const binding = build.events[action.event.name];
		if (!binding) {
			problem(`The action event "${action.event.name}" is not bound to a capability.`);
			return undefined;
		}
		const context = Object.fromEntries(Object.entries(action.event.context ?? {}).map(([key, value]) => [key, resolveDynamicValue(value, at)]));
		return { $action: true, capability: binding.call, input: withContext(binding.input ?? {}, context), then: binding.then ?? [], ...(binding.notice ? { notice: binding.notice } : {}), row };
	};

	const children = (list: ChildList | undefined, scopePath: string | undefined, row: unknown) => {
		if (Array.isArray(list)) {
			list.forEach((id) => visit(id, scopePath, row));
		} else if (list) {
			// A template: one child per item of the list at `path`.
			const path = joinPointer(scopePath, list.path);
			const items = dataModel.get(path);
			(Array.isArray(items) ? items : []).forEach((item, i) => visit(list.componentId, joinPointer(path, String(i)), item));
		}
	};

	const visit = (id: string, scopePath: string | undefined, row: unknown): void => {
		const component = components.get(id);
		if (!component) {
			problem(`The surface has no component "${id}".`);
			return;
		}
		const at = scope(scopePath, row);
		const props = component as unknown as Record<string, unknown>;
		switch (component.component) {
			case 'Column':
			case 'Row':
			case 'List':
				children(props.children as ChildList, scopePath, row);
				return;
			case 'Card':
				children([props.child as string], scopePath, row);
				return;
			case 'Text':
				emit.text(resolveString(props.text, at));
				return;
			case 'Table': {
				const binding = props.rows as { path?: string } | undefined;
				const rowsPath = binding?.path ? joinPointer(scopePath, binding.path) : undefined;
				const rows = rowsPath ? dataModel.get(rowsPath) : undefined;
				const records = Array.isArray(rows) ? rows : [];
				const fields = (props.fields as Field[] | undefined) ?? [];
				const primary = fields.find((field) => field.primary) ?? fields[0];
				const rowActions = (props.rowActions as RowAction[] | undefined) ?? [];
				emit.table({
					columns: fields.map((field) => field.label),
					rows: records.map((record, i) => {
						const rowScope = scope(joinPointer(rowsPath, String(i)), record);
						const actions = rowActions.map((rowAction): SnapshotAction => {
							const action = event(rowAction.action, rowScope, record);
							return {
								id: rowAction.id,
								label: rowAction.label,
								available: (rowAction.visible === undefined || resolveBoolean(rowAction.visible, rowScope)) && action !== undefined,
								...(action ? { action } : {}),
								row: record,
							};
						});
						return {
							label: primary ? String(readPath(record, primary.id) ?? '') : '',
							record,
							actions,
							cells: Object.fromEntries(fields.map((field) => [field.label, cell(field, record, (value) => resolveDynamicValue(value, rowScope), 'en-US')])),
						};
					}),
				});
				if (records.length === 0) {
					emit.text(typeof props.empty === 'string' ? props.empty : 'No items.');
				}
				return;
			}
			default:
				problem(`"${component.component}" is not in the ${build.ui.catalogId} catalog.`);
		}
	};

	if (!components.has('root')) {
		problem('The surface has no "root" component.');
	} else {
		visit('root', undefined, undefined);
	}
	return snapshot;
}
