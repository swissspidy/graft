import { DataContext, DataModel, SurfaceModel, type ComponentApi } from '@a2ui/web_core/v0_9';
import { createSnapshotEmitter, type Action, type EvalContext, type Snapshot, type SnapshotAction } from '@graft/core';
import { createGraftCatalog } from './catalog.ts';
import { withContext } from './events.ts';
import type { A2UIBuild, A2UIComponent } from './types.ts';

/** How a host formats a table cell: Graft's cells, given the field's value in the row's scope. */
export type CellFormatter = (field: TableField, record: unknown, evaluate: (value: unknown) => unknown) => { text: string; tone?: string };

export interface TableField {
	id: string;
	label: string;
	type?: string;
	primary?: boolean;
	value?: unknown;
	tone?: unknown;
}

export interface A2UIHost {
	/** The catalog id builds for this host name, e.g. `graft:wordpress`. */
	catalogId: string;
	/** Host components beyond the base catalog. */
	components?: ComponentApi[];
	/** Formats table cells as the host's renderer does. Default: the value as text. */
	cell?: CellFormatter;
}

/** Snapshot inputs of an A2UI surface form one group: the surface. */
export const INPUT_GROUP = 'surface';

const defaultCell: CellFormatter = (field, _record, evaluate) => {
	const value = evaluate(field.value);
	const tone = field.tone === undefined ? undefined : evaluate(field.tone);
	return { text: value === undefined || value === null || value === '' ? '—' : String(value), ...(typeof tone === 'string' ? { tone } : {}) };
};

/**
 * A Table field as the cells read it: `id` is a JSON Pointer into the row
 * ("author/name"), so its value is that binding unless it computes one.
 */
export function tableField<T extends { id: string; value?: unknown }>(field: T): T {
	return field.value === undefined ? { ...field, value: { path: field.id } } : field;
}

/** A surface for one viewer: the catalog with their `can`, over a data model. */
export function createSurface(build: A2UIBuild, host: A2UIHost, ctx: Pick<EvalContext, 'can' | 'now'>, dataModel: DataModel): SurfaceModel<ComponentApi> {
	const catalog = createGraftCatalog({ id: build.ui.catalogId, components: host.components ?? [], can: ctx.can, now: new Date(ctx.now ?? Date.now()) });
	return new SurfaceModel('graft', catalog, null, undefined, false, dataModel);
}

/** Sets `initial` (once) or `computed` (on every change) in the model, each key seeing the ones before it. */
export function seed(root: DataContext, values: Record<string, unknown> | undefined): void {
	for (const [key, value] of Object.entries(values ?? {})) {
		root.dataModel.set(`/${key}`, root.resolveDynamicValue(value) ?? null);
	}
}

/**
 * Reads an A2UI surface into the semantic snapshot a Graft tree gives,
 * with the Graft catalog: what the viewer reads and what they can do.
 * `entered` holds what the viewer typed (by input component id) and what
 * local actions set (by pointer), in order.
 */
export function snapshotA2UI(build: A2UIBuild, ctx: EvalContext, entered: Record<string, Record<string, unknown>>, host: A2UIHost): Snapshot {
	const { snapshot, emit } = createSnapshotEmitter();
	const problem = (text: string) => {
		const problems = (snapshot.problems ??= []);
		if (!problems.includes(text)) {
			problems.push(text);
		}
	};
	if (build.ui.catalogId !== host.catalogId) {
		problem(`The surface uses the catalog "${build.ui.catalogId}"; this host draws "${host.catalogId}".`);
		return snapshot;
	}
	const components = new Map(build.ui.components.map((component) => [component.id, component]));
	const cellOf = host.cell ?? defaultCell;

	const dataModel = new DataModel({ ...ctx.data, slot: ctx.slot ?? null });
	const surface = createSurface(build, host, ctx, dataModel);
	surface.onError.subscribe((error) => problem(error.message));
	const root = new DataContext(surface, '/');
	const safely = <T>(what: string, fallback: T, run: () => T): T => {
		try {
			return run();
		} catch (error) {
			problem(`${what}: ${(error as Error).message}`);
			return fallback;
		}
	};

	safely('"initial"', undefined, () => seed(root, build.ui.initial));
	for (const [id, value] of Object.entries(entered[INPUT_GROUP] ?? {})) {
		const bound = id.startsWith('/') ? { path: id } : (components.get(id)?.value as { path?: unknown } | undefined);
		if (typeof bound?.path === 'string' && bound.path.startsWith('/')) {
			dataModel.set(bound.path, value ?? null);
		} else {
			problem(`The input "${id}" has no absolute "value" binding to write to.`);
		}
	}
	safely('"computed"', undefined, () => seed(root, build.ui.computed));

	const event = (action: { event?: { name?: string; context?: Record<string, unknown> } } | undefined, at: DataContext, row: unknown): Action | undefined => {
		const name = action?.event?.name;
		const binding = name ? build.events[name] : undefined;
		if (!name || !binding) {
			problem(name ? `The action event "${name}" is not bound to a capability.` : 'An action has no event.');
			return undefined;
		}
		const context = Object.fromEntries(Object.entries(action!.event!.context ?? {}).map(([key, value]) => [key, at.resolveDynamicValue(value) ?? null]));
		return { $action: true, capability: binding.call, input: withContext(binding.input ?? {}, context), then: binding.then ?? [], ...(binding.notice ? { notice: binding.notice } : {}), row };
	};

	const label = (id: unknown, at: DataContext): string => {
		const child = typeof id === 'string' ? components.get(id) : undefined;
		return child?.component === 'Text' ? text(at.resolveDynamicValue(child.text)) : '';
	};

	const seen = new Set<string>();
	const visit = (id: string, at: DataContext, row: unknown): void => {
		const component = components.get(id);
		if (!component) {
			problem(`The surface has no component "${id}".`);
			return;
		}
		const key = `${id}@${at.path}`;
		if (seen.has(key)) {
			problem(`The component "${id}" is drawn twice in the same place (a cycle?).`);
			return;
		}
		seen.add(key);
		if (component.visible !== undefined && !at.resolveDynamicValue(component.visible)) {
			return;
		}
		draw(component, at, row);
	};

	const children = (list: unknown, at: DataContext, row: unknown) => {
		if (Array.isArray(list)) {
			list.forEach((id) => visit(String(id), at, row));
		} else if (list && typeof list === 'object') {
			// A template: one child per item of the list at `path`.
			const { componentId, path } = list as { componentId: string; path: string };
			const scope = at.nested(path);
			const items = dataModel.get(scope.path);
			(Array.isArray(items) ? items : []).forEach((item, i) => visit(componentId, scope.nested(String(i)), item));
		}
	};

	const draw = (component: A2UIComponent, at: DataContext, row: unknown): void => {
		const id = component.id;
		switch (component.component) {
			case 'Column':
			case 'Row':
				children(component.children, at, row);
				return;
			case 'Card':
				children([component.child], at, row);
				return;
			case 'Divider':
				return;
			case 'Text':
				emit.text(text(at.resolveDynamicValue(component.text)));
				return;
			case 'Button': {
				const checks = (component.checks as Array<{ condition: unknown }> | undefined) ?? [];
				const passes = checks.every((check) => Boolean(at.resolveDynamicValue(check.condition)));
				const actionId = component.actionId === undefined ? id : text(at.resolveDynamicValue(component.actionId));
				const base = { id: actionId, label: label(component.child, at), ...(row !== undefined ? { row } : {}) };
				const local = (component.action as { functionCall?: { call: string; args?: Record<string, unknown> } } | undefined)?.functionCall;
				if (local) {
					// A local action: `set` writes the model, recorded like what the viewer enters.
					const target = local.call === 'set' && typeof local.args?.target === 'string' && local.args.target.startsWith('/') ? local.args.target : undefined;
					if (!target) {
						problem(`The action of "${id}" must be an event or {"functionCall": {"call": "set", "args": {"target": "/<pointer>", "value": ...}}}.`);
					}
					const value = target ? (at.resolveDynamicValue(local.args!.value) ?? null) : null;
					emit.action({ ...base, available: passes && target !== undefined, ...(target ? { event: { widget: INPUT_GROUP, name: target, payload: value } } : {}) });
					return;
				}
				const action = event(component.action as never, at, row);
				emit.action({ ...base, available: passes && action !== undefined, ...(action ? { action } : {}) });
				return;
			}
			case 'TextField':
			case 'CheckBox': {
				const fallback = component.component === 'CheckBox' ? false : '';
				const value = at.resolveDynamicValue(component.value) ?? fallback;
				const inputLabel = text(at.resolveDynamicValue(component.label));
				(snapshot.inputs ??= []).push({ widget: INPUT_GROUP, id, label: inputLabel, value });
				emit.text(inputLabel);
				return;
			}
			case 'Table': {
				const scope = at.nested(String((component.rows as { path?: string } | undefined)?.path ?? ''));
				const rows = dataModel.get(scope.path);
				const records = Array.isArray(rows) ? (rows as unknown[]) : [];
				const fields = ((component.fields as TableField[] | undefined) ?? []).map(tableField);
				const primary = fields.find((field) => field.primary) ?? fields[0];
				const rowActions = (component.rowActions as Array<{ id: string; label: string; visible?: unknown; action: never }> | undefined) ?? [];
				emit.table({
					columns: fields.map((field) => field.label),
					rows: records.map((record, i) => {
						const rowScope = scope.nested(String(i));
						const actions = rowActions.map((rowAction): SnapshotAction => {
							const action = event(rowAction.action, rowScope, record);
							const visible = rowAction.visible === undefined || Boolean(rowScope.resolveDynamicValue(rowAction.visible));
							return { id: rowAction.id, label: rowAction.label, available: visible && action !== undefined, ...(action ? { action } : {}), row: record };
						});
						return {
							label: primary ? text(rowScope.resolveDynamicValue(primary.value)) : '',
							record,
							actions,
							cells: Object.fromEntries(fields.map((field) => [field.label, cellOf(field, record, (value) => rowScope.resolveDynamicValue(value))])),
						};
					}),
				});
				if (records.length === 0) {
					emit.text(typeof component.empty === 'string' ? component.empty : 'No items.');
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
		safely('Drawing the surface', undefined, () => visit('root', root, undefined));
	}
	surface.dispose();
	return snapshot;
}

function text(value: unknown): string {
	return value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}
