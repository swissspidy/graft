import { DataContext, DataModel, SurfaceModel, type ComponentApi } from '@a2ui/web_core/v0_9';
import type { Action, EvalContext } from '@swissspidy/graft-core';
import { createGraftCatalog } from './catalog.ts';
import { withContext } from './events.ts';
import { tableField } from './table.ts';
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
	/** Base components this host cannot draw (e.g. inputs where the host has none). */
	without?: string[];
	/** Formats table cells as the host's renderer does. Default: the value as text. */
	cell?: CellFormatter;
}

/** What the viewer entered and local actions set, by input component id or pointer, in order. */
export const INPUT_GROUP = 'surface';

const defaultCell: CellFormatter = (field, _record, evaluate) => {
	const value = evaluate(field.value);
	const tone = field.tone === undefined ? undefined : evaluate(field.tone);
	return { text: value === undefined || value === null || value === '' ? '—' : String(value), ...(typeof tone === 'string' ? { tone } : {}) };
};

/** A surface for one viewer: the catalog with their `can`, over a data model. */
export function createSurface(build: A2UIBuild, host: A2UIHost, ctx: Pick<EvalContext, 'can' | 'now'>, dataModel: DataModel): SurfaceModel<ComponentApi> {
	const catalog = createGraftCatalog({ id: build.ui.catalogId, components: host.components ?? [], without: host.without ?? [], can: ctx.can, now: new Date(ctx.now ?? Date.now()) });
	return new SurfaceModel('graft', catalog, null, undefined, false, dataModel);
}

/**
 * Sets `initial` (once) or `computed` (on every change) in the model, each
 * key seeing the ones before it. Values are copied: a literal object would
 * otherwise be the build's own, and what the viewer enters would write into it.
 */
export function seed(root: DataContext, values: Record<string, unknown> | undefined): void {
	for (const [key, value] of Object.entries(values ?? {})) {
		root.dataModel.set(`/${key}`, structuredClone(root.resolveDynamicValue(value) ?? null));
	}
}

/** A button as drawn: what it does, and whether the viewer can use it now. */
export interface DrawnButton {
	/** Its action id (`actionId`, else the component id). */
	id: string;
	label: string;
	available: boolean;
	variant?: string;
	/** An event's capability call, resolved for this button. */
	action?: Action;
	/** A local action: the pointer `set` writes, and the value. */
	set?: { target: string; value: unknown };
	/** The table row or template item it belongs to. */
	row?: unknown;
}

export interface DrawnTable {
	columns: string[];
	rows: Array<{ label: string; record: unknown; cells: Record<string, { text: string; tone?: string }>; actions: DrawnButton[] }>;
	empty: string;
	/** Fields as written, for hosts that format columns themselves. */
	fields: TableField[];
}

/** What a host does with the surface as it is walked: a snapshot, Block Kit, … */
export interface A2UIDrawer {
	text(text: string, variant: string | undefined): void;
	button(button: DrawnButton): void;
	input(input: { id: string; component: string; label: string; value: unknown }): void;
	table(table: DrawnTable): void;
	/** A container: its children are drawn inside `draw`. */
	group(kind: 'Column' | 'Row' | 'Card', draw: () => void): void;
	problem(text: string): void;
}

/**
 * Walks an A2UI surface for one viewer: the data model from the data
 * sources, the slot, `initial`, what was entered and set, then `computed`;
 * every visible component resolved in its scope with the Graft catalog,
 * and handed to the drawer.
 */
export function walkA2UI(build: A2UIBuild, ctx: EvalContext, entered: Record<string, Record<string, unknown>>, host: A2UIHost, drawer: A2UIDrawer): void {
	if (build.ui.catalogId !== host.catalogId) {
		drawer.problem(`The surface uses the catalog "${build.ui.catalogId}"; this host draws "${host.catalogId}".`);
		return;
	}
	const components = new Map(build.ui.components.map((component) => [component.id, component]));
	const cellOf = host.cell ?? defaultCell;
	// A copy: inputs and local actions write into the model, never into the data sources' results.
	const dataModel = new DataModel(structuredClone({ ...ctx.data, slot: ctx.slot ?? null }));
	const surface = createSurface(build, host, ctx, dataModel);
	surface.onError.subscribe((error) => drawer.problem(error.message));
	const root = new DataContext(surface, '/');
	const safely = (what: string, run: () => void) => {
		try {
			run();
		} catch (error) {
			drawer.problem(`${what}: ${(error as Error).message}`);
		}
	};

	safely('"initial"', () => seed(root, build.ui.initial));
	for (const [id, value] of Object.entries(entered[INPUT_GROUP] ?? {})) {
		const bound = id.startsWith('/') ? { path: id } : (components.get(id)?.value as { path?: unknown } | undefined);
		if (typeof bound?.path === 'string' && bound.path.startsWith('/')) {
			dataModel.set(bound.path, value ?? null);
		} else {
			drawer.problem(`The input "${id}" has no absolute "value" binding to write to.`);
		}
	}
	safely('"computed"', () => seed(root, build.ui.computed));

	const event = (action: { event?: { name?: string; context?: Record<string, unknown> } } | undefined, at: DataContext, row: unknown): Action | undefined => {
		const name = action?.event?.name;
		const binding = name ? build.events[name] : undefined;
		if (!name || !binding) {
			drawer.problem(name ? `The action event "${name}" is not bound to a capability.` : 'An action has no event.');
			return undefined;
		}
		const context = Object.fromEntries(Object.entries(action!.event!.context ?? {}).map(([key, value]) => [key, at.resolveDynamicValue(value) ?? null]));
		return { $action: true, capability: binding.call, input: withContext(binding.input ?? {}, context), then: binding.then ?? [], ...(binding.notice ? { notice: binding.notice } : {}), row: row ?? context };
	};

	/** A button or row action: a local `set`, or an event's capability call. */
	const press = (source: string, action: unknown, at: DataContext, row: unknown, base: Omit<DrawnButton, 'available'>, usable: boolean): DrawnButton => {
		const local = (action as { functionCall?: { call: string; args?: Record<string, unknown> } } | undefined)?.functionCall;
		if (local) {
			const target = local.call === 'set' && typeof local.args?.target === 'string' && local.args.target.startsWith('/') ? local.args.target : undefined;
			if (!target) {
				drawer.problem(`The action of "${source}" must be an event or {"functionCall": {"call": "set", "args": {"target": "/<pointer>", "value": ...}}}.`);
			}
			return { ...base, available: usable && target !== undefined, ...(target ? { set: { target, value: at.resolveDynamicValue(local.args!.value) ?? null } } : {}) };
		}
		const resolved = event(action as never, at, row);
		return { ...base, available: usable && resolved !== undefined, ...(resolved ? { action: resolved } : {}) };
	};

	const label = (id: unknown, at: DataContext): string => {
		const child = typeof id === 'string' ? components.get(id) : undefined;
		return child?.component === 'Text' ? text(at.resolveDynamicValue(child.text)) : '';
	};

	const seen = new Set<string>();
	const visit = (id: string, at: DataContext, row: unknown): void => {
		const component = components.get(id);
		if (!component) {
			drawer.problem(`The surface has no component "${id}".`);
			return;
		}
		const key = `${id}@${at.path}`;
		if (seen.has(key)) {
			drawer.problem(`The component "${id}" is drawn twice in the same place (a cycle?).`);
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
				drawer.group(component.component, () => children(component.children, at, row));
				return;
			case 'Card':
				drawer.group('Card', () => children([component.child], at, row));
				return;
			case 'Divider':
				drawer.text('', 'divider');
				return;
			case 'Text':
				drawer.text(text(at.resolveDynamicValue(component.text)), typeof component.variant === 'string' ? component.variant : undefined);
				return;
			case 'Button': {
				const checks = (component.checks as Array<{ condition: unknown }> | undefined) ?? [];
				const passes = checks.every((check) => Boolean(at.resolveDynamicValue(check.condition)));
				const base = {
					id: component.actionId === undefined ? id : text(at.resolveDynamicValue(component.actionId)),
					label: label(component.child, at),
					...(typeof component.variant === 'string' ? { variant: component.variant } : {}),
					...(row !== undefined ? { row } : {}),
				};
				drawer.button(press(id, component.action, at, row, base, passes));
				return;
			}
			case 'TextField':
			case 'CheckBox': {
				const fallback = component.component === 'CheckBox' ? false : '';
				drawer.input({ id, component: component.component, label: text(at.resolveDynamicValue(component.label)), value: at.resolveDynamicValue(component.value) ?? fallback });
				return;
			}
			case 'Table': {
				const scope = at.nested(String((component.rows as { path?: string } | undefined)?.path ?? ''));
				const rows = dataModel.get(scope.path);
				const records = Array.isArray(rows) ? (rows as unknown[]) : [];
				const fields = ((component.fields as TableField[] | undefined) ?? []).map(tableField);
				const primary = fields.find((field) => field.primary) ?? fields[0];
				const rowActions = (component.rowActions as Array<{ id: string; label: string; variant?: string; visible?: unknown; action: never }> | undefined) ?? [];
				drawer.table({
					columns: fields.map((field) => field.label),
					fields,
					empty: component.empty === undefined ? 'No items.' : text(at.resolveDynamicValue(component.empty)),
					rows: records.map((record, i) => {
						const rowScope = scope.nested(String(i));
						return {
							label: primary ? text(rowScope.resolveDynamicValue(primary.value)) : '',
							record,
							cells: Object.fromEntries(fields.map((field) => [field.label, cellOf(field, record, (value) => rowScope.resolveDynamicValue(value))])),
							actions: rowActions.map((rowAction): DrawnButton => {
								const visible = rowAction.visible === undefined || Boolean(rowScope.resolveDynamicValue(rowAction.visible));
								const base = { id: rowAction.id, label: rowAction.label, ...(rowAction.variant ? { variant: rowAction.variant } : {}), row: record };
								return press(`${id}/${rowAction.id}`, rowAction.action, rowScope, record, base, visible);
							}),
						};
					}),
				});
				return;
			}
			default:
				drawer.problem(`"${component.component}" is not in the ${build.ui.catalogId} catalog.`);
		}
	};

	if (!components.has('root')) {
		drawer.problem('The surface has no "root" component.');
	} else {
		safely('Drawing the surface', () => visit('root', root, undefined));
	}
	surface.dispose();
}

function text(value: unknown): string {
	return value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}
