import { createSnapshotEmitter, type Action, type Build, type EvalContext, type Snapshot, type SnapshotAction } from '../../packages/core/src/index.ts';
import {
	DataModel,
	isDataBinding,
	joinPointer,
	resolveBoolean,
	resolveDynamicValue,
	resolveString,
	type ChildList,
	type ComponentDefinition,
	type JsonValue,
	type ResolveScope,
} from '../../packages/a2ui/src/core/index.ts';
import { cell, type Field } from '../../hosts/wordpress/adapter/src/cells.ts';
import { graftFunctions } from './catalog.ts';
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
	ui: {
		protocol: string;
		catalogId: string;
		/** Data model values set when the surface is drawn, as A2UI values (e.g. a form seeded from the slot). */
		initial?: Record<string, unknown>;
		/** Data model values recomputed whenever the model changes (e.g. a filtered list), as A2UI values. */
		computed?: Record<string, unknown>;
		components: ComponentDefinition[];
	};
	events: Record<string, EventBinding>;
}

export interface EventBinding {
	call: string;
	input?: unknown;
	then?: string[];
	notice?: string;
}

interface EventAction {
	event: { name: string; context?: Record<string, unknown> };
}

interface LocalAction {
	functionCall: { call: string; args?: Record<string, unknown> };
}

interface RowAction {
	id: string;
	label: string;
	visible?: unknown;
	action: EventAction;
}

/** Snapshot inputs of an A2UI surface are one group: the surface. */
export const INPUT_GROUP = 'surface';

/** The data model a surface starts with: data sources, the slot, then `initial`. */
export function initialDataModel(build: A2UIBuild, data: Record<string, unknown>, slot: unknown, scope: (model: DataModel) => ResolveScope): DataModel {
	const model = new DataModel({ ...data, slot } as JsonValue);
	const at = scope(model);
	for (const [key, value] of Object.entries(build.ui.initial ?? {})) {
		model.set(`/${key}`, resolveInitial(value, at) as JsonValue);
	}
	return model;
}

/** Writes `computed` into the model, each key seeing the ones before it. */
export function computeDataModel(build: A2UIBuild, model: DataModel, at: ResolveScope): void {
	for (const [key, value] of Object.entries(build.ui.computed ?? {})) {
		model.set(`/${key}`, resolveInitial(value, at) as JsonValue);
	}
}

/**
 * A Table field as Graft's cells read it: `id` is a JSON Pointer into the
 * row ("author/name"), so its value is that binding unless it computes one.
 */
export function tableField<T extends { id: string; value?: unknown }>(field: T): T {
	return field.value === undefined ? { ...field, value: { path: field.id } } : field;
}

// `initial` nests plain objects around A2UI values.
const resolveInitial = (value: unknown, at: ResolveScope): unknown =>
	value && typeof value === 'object' && !Array.isArray(value) && !isDataBinding(value) && !('call' in value)
		? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, resolveInitial(inner, at)]))
		: (resolveDynamicValue(value, at) ?? null);

/**
 * Reads an A2UI surface into the same semantic snapshot a Graft tree gives,
 * with the `graft:wordpress` catalog. `entered` holds what the viewer typed,
 * by input component id; it is written to each input's bound path.
 */
export function snapshotA2UI(build: A2UIBuild, ctx: EvalContext, entered: Record<string, Record<string, unknown>> = {}): Snapshot {
	const { snapshot, emit } = createSnapshotEmitter();
	const problem = (text: string) => {
		const problems = (snapshot.problems ??= []);
		if (!problems.includes(text)) {
			problems.push(text);
		}
	};
	const components = new Map(build.ui.components.map((component) => [component.id, component]));
	const now = new Date(ctx.now ?? Date.now());
	const scopeOf = (dataModel: DataModel, scopePath?: string, row?: unknown): ResolveScope => ({
		dataModel,
		functions: graftFunctions({ can: ctx.can, now, row }),
		scopePath,
		locale: 'en-US',
	});

	let dataModel: DataModel;
	try {
		dataModel = initialDataModel(build, ctx.data, ctx.slot ?? null, (model) => scopeOf(model));
	} catch (error) {
		problem(`"initial" could not be resolved: ${(error as Error).message}`);
		dataModel = new DataModel({ ...ctx.data, slot: ctx.slot ?? null } as JsonValue);
	}
	// What the viewer entered goes where each input is bound; local `set` actions name the pointer.
	for (const [id, value] of Object.entries(entered[INPUT_GROUP] ?? {})) {
		const binding = id.startsWith('/') ? { path: id } : components.get(id)?.value;
		if (isDataBinding(binding) && binding.path.startsWith('/')) {
			dataModel.set(binding.path, value as JsonValue);
		} else {
			problem(`The input "${id}" has no absolute "value" binding to write to.`);
		}
	}
	const scope = (scopePath?: string, row?: unknown) => scopeOf(dataModel, scopePath, row);
	try {
		computeDataModel(build, dataModel, scope());
	} catch (error) {
		problem(`"computed" could not be resolved: ${(error as Error).message}`);
	}
	const safely = <T>(what: string, fallback: T, run: () => T): T => {
		try {
			return run();
		} catch (error) {
			problem(`${what}: ${(error as Error).message}`);
			return fallback;
		}
	};

	const event = (action: EventAction | undefined, at: ResolveScope, row: unknown): Action | undefined => {
		const binding = action?.event?.name ? build.events[action.event.name] : undefined;
		if (!action?.event?.name || !binding) {
			problem(action?.event?.name ? `The action event "${action.event.name}" is not bound to a capability.` : 'An action has no event.');
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

	const label = (id: unknown, at: ResolveScope): string => {
		const child = typeof id === 'string' ? components.get(id) : undefined;
		return child?.component === 'Text' ? resolveString(child.text, at) : '';
	};

	const seen = new Set<string>();
	const visit = (id: string, scopePath: string | undefined, row: unknown): void => {
		const component = components.get(id);
		if (!component) {
			problem(`The surface has no component "${id}".`);
			return;
		}
		const key = `${id}@${scopePath ?? ''}`;
		if (seen.has(key)) {
			problem(`The component "${id}" is drawn twice in the same place (a cycle?).`);
			return;
		}
		seen.add(key);
		const at = scope(scopePath, row);
		const props = component as Record<string, unknown>;
		if (props.visible !== undefined && !safely(`"visible" of "${id}"`, false, () => resolveBoolean(props.visible, at))) {
			return;
		}
		switch (component.component) {
			case 'Column':
			case 'Row':
			case 'List':
				children(props.children as ChildList, scopePath, row);
				return;
			case 'Card':
				children([props.child as string], scopePath, row);
				return;
			case 'Divider':
				return;
			case 'Text':
				emit.text(safely(`The text of "${id}"`, '', () => resolveString(props.text, at)));
				return;
			case 'Button': {
				// Not drawn as text: its label is in the action.
				const checks = (props.checks as Array<{ condition: unknown }> | undefined) ?? [];
				const passes = checks.every((check, i) => safely(`Check ${i + 1} of "${id}"`, false, () => resolveBoolean(check.condition, at)));
				const actionId = props.actionId === undefined ? id : safely(`"actionId" of "${id}"`, id, () => resolveString(props.actionId, at));
				const base = { id: actionId, label: label(props.child, at), ...(row !== undefined ? { row } : {}) };
				const local = (props.action as LocalAction | undefined)?.functionCall;
				if (local) {
					// A local action: `set` writes the model, recorded like what the viewer enters.
					const args = Object.fromEntries(Object.entries(local.args ?? {}).map(([key, value]) => [key, safely(`The action of "${id}"`, null, () => resolveDynamicValue(value, at))]));
					const target = local.call === 'set' && typeof args.target === 'string' && args.target.startsWith('/') ? args.target : undefined;
					if (!target) {
						problem(`The action of "${id}" must be {"functionCall": {"call": "set", "args": {"target": "/<pointer>", "value": ...}}} or an event.`);
					}
					emit.action({ ...base, available: passes && target !== undefined, ...(target ? { event: { widget: INPUT_GROUP, name: target, payload: args.value ?? null } } : {}) });
					return;
				}
				const action = event(props.action as EventAction | undefined, at, row);
				emit.action({ ...base, available: passes && action !== undefined, ...(action ? { action } : {}) });
				return;
			}
			case 'TextField':
			case 'CheckBox': {
				const fallback = component.component === 'CheckBox' ? false : '';
				const value = safely(`The value of "${id}"`, null, () => resolveDynamicValue(props.value, at)) ?? fallback;
				(snapshot.inputs ??= []).push({ widget: INPUT_GROUP, id, label: resolveString(props.label, at), value });
				emit.text(resolveString(props.label, at));
				return;
			}
			case 'Table': {
				const binding = props.rows as { path?: string } | undefined;
				const rowsPath = binding?.path ? joinPointer(scopePath, binding.path) : undefined;
				const rows = rowsPath ? dataModel.get(rowsPath) : undefined;
				const records = Array.isArray(rows) ? rows : [];
				const fields = ((props.fields as Field[] | undefined) ?? []).map(tableField);
				const primary = fields.find((field) => field.primary) ?? fields[0];
				const rowActions = (props.rowActions as RowAction[] | undefined) ?? [];
				emit.table({
					columns: fields.map((field) => field.label),
					rows: records.map((record, i) => {
						const rowScope = scope(joinPointer(rowsPath, String(i)), record);
						const actions = rowActions.map((rowAction): SnapshotAction => {
							const action = event(rowAction.action, rowScope, record);
							const visible = rowAction.visible === undefined || safely(`"visible" of row action "${rowAction.id}"`, false, () => resolveBoolean(rowAction.visible, rowScope));
							return { id: rowAction.id, label: rowAction.label, available: visible && action !== undefined, ...(action ? { action } : {}), row: record };
						});
						return {
							label: primary ? String(safely(`Field "${primary.label}"`, null, () => resolveDynamicValue(primary.value, rowScope)) ?? '') : '',
							record,
							actions,
							cells: Object.fromEntries(fields.map((field) => [field.label, cell(field, record, (value) => safely(`Field "${field.label}"`, null, () => resolveDynamicValue(value, rowScope)), 'en-US')])),
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
