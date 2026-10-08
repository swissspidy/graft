import { describeSpec, describeSurface, usableCapabilities, type Build, type Check, type Migration, type Refs, type Spec, type Surface, type UiFormat } from '@graft/core';
import { BASE_COMPONENTS, PROTOCOL } from './catalog.ts';
import { CATALOG_GUIDE } from './guide.ts';
import { snapshotA2UI } from './snapshot.ts';
import type { A2UIHost } from './walk.ts';
import { isA2UIBuild, type A2UIBuild, type A2UIComponent, type EventBinding } from './types.ts';
import { collectScopes, validateA2UI } from './validate.ts';

export interface A2UIFormatHost extends A2UIHost {
	/** The host's name, as surfaces give it (e.g. "wordpress"). */
	host: string;
	/** The host's components for the compiler's prompt, in the catalog guide's style. */
	guide?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A2UI as a Graft UI format for one host: register it with `registerUiFormat`. */
export function createA2UIFormat(host: A2UIFormatHost): UiFormat {
	const componentNames = [...new Set([...BASE_COMPONENTS.map((c) => c.name).filter((name) => !(host.without ?? []).includes(name)), ...(host.components ?? []).map((c) => c.name)])].sort();
	return {
		name: 'A2UI',
		host: host.host,
		handles: (build) => isA2UIBuild(build) && typeof build.ui.protocol === 'string' && build.ui.protocol.startsWith('a2ui/') && build.ui.catalogId === host.catalogId,
		validate: (build, surface, spec) => validateA2UI(build, surface, host, spec),
		refs: (build) => a2uiRefs(build as unknown as A2UIBuild),
		snapshot: (build, ctx, entered) => snapshotA2UI(build as unknown as A2UIBuild, ctx, entered, host),
		migrate: (build, migration) => migrateA2UI(build as unknown as A2UIBuild, migration) as unknown as Build | undefined,
		slotPropsUsed: (build) => slotPropsUsedA2UI(build as unknown as A2UIBuild),
		compiler: {
			system: (spec, surface, notes) => a2uiSystem(spec, surface, host, notes),
			prompt: (spec, checks, previous, feedback) => a2uiPrompt(spec, checks, previous as unknown as A2UIBuild | undefined, feedback),
			schema: (spec, surface) => a2uiOutputSchema(spec, surface, componentNames),
			assemble: (output) => assembleA2UI(output, host.catalogId) as { value?: Partial<Build>; problems: string[] },
			content: (build) => ({ ui: (build as unknown as A2UIBuild).ui, events: (build as unknown as A2UIBuild).events }),
			checksSystem: (base) =>
				`${base.replace(/\nComponents \(props[\s\S]*?(?=\nCapabilities you may use)/, '')}\n\nThe customization's UI will be an A2UI surface:\n${catalogGuide(host)}\n\nIn checks, an action id is a button's action id or a table row action's id, and an input id is a text field's or checkbox's id.`,
		},
	};
}

/** What the UI calls (event bindings), the scopes its `can` checks name, and the catalog it uses. */
export function a2uiRefs(build: A2UIBuild): Pick<Refs, 'capabilities' | 'scopes' | 'catalog'> {
	const catalog: Record<string, Set<string>> = {};
	for (const { id: _id, component, ...props } of build.ui.components) {
		const used = (catalog[component] ??= new Set());
		Object.keys(props).forEach((prop) => used.add(prop));
	}
	return {
		capabilities: [...new Set(Object.values(build.events).map((event) => event.call))].sort(),
		scopes: [...collectScopes(build.ui, new Set())].sort(),
		catalog: Object.fromEntries(
			Object.entries(catalog)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, props]) => [name, [...props].sort()]),
		),
	};
}

/** Every `can` call's scope renamed, wherever it is in the surface. */
function mapCan(value: unknown, rename: (scope: string) => string): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => mapCan(item, rename));
	}
	if (isObject(value)) {
		const object = Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, mapCan(inner, rename)]));
		if (object.call === 'can' && isObject(object.args) && typeof object.args.scope === 'string') {
			object.args = { ...object.args, scope: rename(object.args.scope) };
		}
		return object;
	}
	return value;
}

/**
 * A host migration applied to the UI (core has already moved the mount and
 * data sources): capabilities in event bindings, scopes in `can` calls.
 * Component and prop migrations name the host's tree components, which an
 * A2UI surface does not use; its components belong to the catalog, which is
 * versioned on its own (a new catalog id). A removal is handled by core.
 */
export function migrateA2UI(build: A2UIBuild, migration: Migration): A2UIBuild | undefined {
	if (migration.op !== 'rename') {
		return build;
	}
	const { kind, from, to } = migration;
	if (kind === 'capability') {
		return {
			...build,
			events: Object.fromEntries(Object.entries(build.events).map(([name, binding]) => [name, { ...binding, call: binding.call === from ? to : binding.call }])),
		};
	}
	if (kind === 'scope') {
		return { ...build, ui: mapCan(build.ui, (scope) => (scope === from ? to : scope)) as A2UIBuild['ui'] };
	}
	return build;
}

/** The slot props the surface reads: the first key of every /slot/... pointer. */
export function slotPropsUsedA2UI(build: A2UIBuild): string[] {
	const used = new Set<string>();
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			value.forEach(walk);
		} else if (isObject(value)) {
			if (typeof value.path === 'string' && value.path.startsWith('/slot/')) {
				used.add(value.path.split('/')[2]!);
			}
			Object.values(value).forEach(walk);
		}
	};
	walk(build.ui);
	return [...used].sort();
}

// The compiler's UI phase.

const names = (values: readonly string[]) => (values.length > 0 ? { type: 'string', enum: [...values] } : { type: 'string' });

/** The model's output: a flat component list fits structured outputs (no recursion) as it is. */
export function a2uiOutputSchema(spec: Spec, surface: Surface, components: string[]): Record<string, unknown> {
	const usable = usableCapabilities(spec, surface);
	const reads = usable.filter((name) => surface.capabilities[name]?.kind === 'read');
	return {
		type: 'object',
		additionalProperties: false,
		required: ['components', 'initial_json', 'computed_json', 'data', 'events'],
		properties: {
			components: {
				type: 'array',
				description: 'The A2UI components. One has id "root".',
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['id', 'component', 'props_json'],
					properties: {
						id: { type: 'string' },
						component: names(components),
						props_json: { type: 'string', description: 'JSON object of the component\'s other properties (children, text, action, visible, ...); "{}" for none.' },
					},
				},
			},
			initial_json: { type: 'string', description: 'JSON object: data model values set when the surface is drawn; "{}" for none.' },
			computed_json: { type: 'string', description: 'JSON object: data model values recomputed whenever the model changes; "{}" for none.' },
			data: {
				type: 'array',
				description: 'Named data sources, loaded into the data model at /<name>.',
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['name', 'call', 'input_json'],
					properties: {
						name: { type: 'string' },
						call: names(reads),
						input_json: { type: 'string', description: 'JSON input for the capability; "null" for none. {"$slot": "post.id"} inserts a slot value.' },
					},
				},
			},
			events: {
				type: 'array',
				description: 'What each action event does.',
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['name', 'call', 'input_json', 'then', 'notice'],
					properties: {
						name: { type: 'string' },
						call: names(usable),
						input_json: { type: 'string', description: 'JSON input; {"$context": "<key>"} is replaced by the event context value.' },
						then: { type: 'array', items: { type: 'string' } },
						notice: { anyOf: [{ type: 'string' }, { type: 'null' }] },
					},
				},
			},
		},
	};
}

/** The surface as far as an A2UI build sees it: Graft's tree components are replaced by the catalog. */
export function describeHost(spec: Spec, surface: Surface): string {
	return describeSurface(spec, surface).replace(/\nComponents \(props[\s\S]*?(?=\nCapabilities you may use)/, '');
}

/** The catalog guide with the host's components; also what the checks phase is told the UI can be. */
export function catalogGuide(host: A2UIFormatHost): string {
	return host.guide ? `${CATALOG_GUIDE}\n\nThis host's own components:\n${host.guide}` : CATALOG_GUIDE;
}

export function a2uiSystem(spec: Spec, surface: Surface, host: A2UIFormatHost, notes?: string): string {
	return [
		"You build customizations of a web application as A2UI surfaces. The surface may only use the components and functions of the catalog below, the slot's data and the capabilities listed; it is drawn by a trusted renderer and every capability call is permission-checked. Keep it minimal: build what the spec asks, nothing it puts out of scope.",
		catalogGuide(host),
		notes ?? '',
		describeHost(spec, surface),
	]
		.filter(Boolean)
		.join('\n\n');
}

export function a2uiPrompt(spec: Spec, checks: Check[], previous: A2UIBuild | undefined, feedback: string[]): string {
	const lines = [
		'Build this spec. Your build must pass these frozen checks. Action ids in the checks are Button action ids (their component id unless "actionId" says otherwise) or table row action ids; input ids are TextField and CheckBox component ids. "available": false means hidden or disabled.',
		'',
		describeSpec(spec),
		'',
		`Checks: ${JSON.stringify(checks)}`,
	];
	if (previous) {
		lines.push(
			'',
			'This replaces an earlier build of the same spec that no longer fits the host. Keep its layout and wording where the parts still exist:',
			JSON.stringify(previous.ui ? { ui: previous.ui, data: previous.data, events: previous.events } : previous),
		);
	}
	if (feedback.length > 0) {
		lines.push('', 'Your previous attempt was rejected:', ...feedback.map((f) => `- ${f}`), 'Fix these problems and return the complete build.');
	}
	return lines.join('\n');
}

function parse(text: unknown, what: string, problems: string[]): unknown {
	try {
		return JSON.parse(String(text)) as unknown;
	} catch (error) {
		problems.push(`${what} is not valid JSON: ${(error as Error).message}.`);
		return undefined;
	}
}

/** Turns the model's output into the build's `ui`, `data` and `events`. */
export function assembleA2UI(output: unknown, catalogId: string): { value?: Pick<A2UIBuild, 'ui' | 'data' | 'events'>; problems: string[] } {
	const problems: string[] = [];
	if (!isObject(output) || !Array.isArray(output.components) || !Array.isArray(output.data) || !Array.isArray(output.events)) {
		return { problems: ['The output must have "components", "data" and "events" arrays.'] };
	}
	const components: A2UIComponent[] = [];
	for (const item of output.components as Array<{ id: string; component: string; props_json: string }>) {
		const props = parse(item.props_json, `Properties of "${item.id}"`, problems);
		if (props !== undefined && !isObject(props)) {
			problems.push(`Properties of "${item.id}" must be an object.`);
			continue;
		}
		const { id: _id, component: _component, ...rest } = (props ?? {}) as Record<string, unknown>;
		components.push({ id: item.id, component: item.component, ...rest });
	}
	const sections: Record<string, Record<string, unknown>> = {};
	for (const section of ['initial', 'computed'] as const) {
		const value = parse(output[`${section}_json`] ?? '{}', `${section}_json`, problems);
		if (value !== undefined && !isObject(value)) {
			problems.push(`${section}_json must be an object.`);
		} else if (isObject(value) && Object.keys(value).length > 0) {
			sections[section] = value;
		}
	}
	const data: A2UIBuild['data'] = {};
	for (const item of output.data as Array<{ name: string; call: string; input_json: string }>) {
		if (!/^[a-z][a-zA-Z0-9_-]*$/.test(item.name) || item.name === 'slot') {
			problems.push(`Data source name "${item.name}" must start with a lowercase letter, use letters, digits, _ or -, and not be "slot".`);
		}
		const input = parse(item.input_json, `Input of data source "${item.name}"`, problems);
		data[item.name] = input === null || input === undefined ? { call: item.call } : { call: item.call, input: input as never };
	}
	const events: Record<string, EventBinding> = {};
	for (const item of output.events as Array<{ name: string; call: string; input_json: string; then: string[]; notice: string | null }>) {
		if (events[item.name]) {
			problems.push(`Event "${item.name}" is bound twice.`);
		}
		const input = parse(item.input_json, `Input of event "${item.name}"`, problems);
		events[item.name] = { call: item.call, ...(input !== undefined && input !== null ? { input } : {}), ...(item.then.length ? { then: item.then } : {}), ...(item.notice ? { notice: item.notice } : {}) };
	}
	if (problems.length > 0) {
		return { problems };
	}
	return { value: { ui: { protocol: PROTOCOL, catalogId, ...sections, components }, data, events }, problems };
}
