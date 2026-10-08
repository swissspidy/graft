import type { Catalog, ComponentApi } from '@a2ui/web_core/v0_9';
import { compileSchema, type Build, type Diagnostic, type Spec, type Surface } from '@graft/core';
import type { z } from 'zod';
import { createGraftCatalog, INPUT_COMPONENTS } from './catalog.ts';
import type { A2UIHost } from './walk.ts';
import type { A2UIBuild, A2UIComponent } from './types.ts';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isBinding = (value: unknown): value is { path: string } => isObject(value) && typeof value.path === 'string' && Object.keys(value).length === 1;
const isCall = (value: unknown): value is { call: string; args?: Record<string, unknown> } => isObject(value) && typeof value.call === 'string' && Object.keys(value).every((k) => ['call', 'args', 'returnType'].includes(k));
const isDynamic = (value: unknown) => isBinding(value) || isCall(value);

/** Pointers written with "." where JSON Pointers use "/" (e.g. "can.publish"). */
const dotted = (path: string) => path.split('/').some((segment) => /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(segment));

/** The catalog as validation sees it: no viewer, so `can` and `daysSince` never run. */
function catalogFor(host: A2UIHost): Catalog<ComponentApi> {
	return createGraftCatalog({ id: host.catalogId, components: host.components ?? [], without: host.without ?? [], can: () => false, now: new Date(0) });
}

/** zod issues outside dynamic values: a binding or call stands for anything its schema allows. */
function schemaProblems(schema: z.ZodTypeAny, value: Record<string, unknown>): Array<{ path: string; message: string }> {
	const result = schema.safeParse(value);
	if (result.success) {
		return [];
	}
	return result.error.issues
		.filter((issue) => {
			// Skip issues at or under a dynamic value: its type is only known when drawn.
			let at: unknown = value;
			for (const key of issue.path) {
				if (isDynamic(at)) {
					return false;
				}
				at = isObject(at) || Array.isArray(at) ? (at as Record<string, unknown>)[key as string] : undefined;
			}
			return !isDynamic(at) || issue.code === 'unrecognized_keys';
		})
		.map((issue) => ({ path: issue.path.map(String).join('/'), message: issue.message }));
}

/**
 * Problems with a capability input: checked against the capability's input
 * schema, with what is filled in at run time ({"$context": ...} in events,
 * {"$slot": ...} in data sources) exempt.
 */
export function inputProblems(surface: Surface, capability: string, input: unknown): string[] {
	const schema = surface.capabilities[capability]?.input;
	if (!schema) {
		return [];
	}
	const placeholders: string[] = [];
	const fill = (value: unknown, path: string): unknown => {
		if (isObject(value) && Object.keys(value).length === 1 && (typeof value.$context === 'string' || typeof value.$slot === 'string')) {
			placeholders.push(path);
			return null;
		}
		if (Array.isArray(value)) {
			return value.map((item, i) => fill(item, `${path}/${i}`));
		}
		return isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, `${path}/${key}`)])) : value;
	};
	const validate = compileSchema(schema as object);
	if (validate(fill(input ?? {}, ''))) {
		return [];
	}
	return (validate.errors ?? [])
		.filter((error) => {
			const at = error.instancePath;
			return !placeholders.some((p) => at === p || at.startsWith(`${p}/`)) && !((error.keyword === 'anyOf' || error.keyword === 'oneOf') && placeholders.includes(at));
		})
		.map((error) => `${error.instancePath || 'the input'} ${error.message ?? 'is invalid'}`);
}

/**
 * Static problems with an A2UI build's UI against the catalog and the
 * surface, before anything runs: structure, every component's properties,
 * functions and their arguments, inputs, events and what they call.
 */
export function validateA2UI(value: Build, surface: Surface, host: A2UIHost, spec?: Spec): Diagnostic[] {
	const build = value as unknown as A2UIBuild;
	const diagnostics: Diagnostic[] = [];
	const error = (code: string, path: string, message: string) => diagnostics.push({ severity: 'error', code, path, message });
	if (!isObject(build.ui) || !Array.isArray(build.ui.components)) {
		error('a2ui-shape', '/ui', 'The UI must have a "components" list.');
		return diagnostics;
	}
	if (!build.ui.protocol.startsWith('a2ui/v0.9')) {
		error('a2ui-protocol', '/ui/protocol', `Only A2UI v0.9 surfaces are supported, not "${build.ui.protocol}".`);
	}
	if (build.ui.catalogId !== host.catalogId) {
		error('a2ui-catalog', '/ui/catalogId', `${surface.host} draws the "${host.catalogId}" catalog, not "${build.ui.catalogId}".`);
		return diagnostics;
	}
	const catalog = catalogFor(host);

	// Components: unique ids, a root, references that exist and reach everything.
	const ids = new Map<string, number>();
	build.ui.components.forEach((component, i) => {
		if (ids.has(component.id)) {
			error('a2ui-duplicate-id', `/ui/components/${i}/id`, `Component id "${component.id}" is used twice.`);
		}
		ids.set(component.id, i);
	});
	if (!ids.has('root')) {
		error('a2ui-no-root', '/ui/components', 'No component has id "root".');
	}
	const references = (component: A2UIComponent): string[] => {
		const out: string[] = [];
		if (Array.isArray(component.children)) {
			out.push(...component.children.map(String));
		} else if (isObject(component.children) && typeof component.children.componentId === 'string') {
			out.push(component.children.componentId);
		}
		if (typeof component.child === 'string') {
			out.push(component.child);
		}
		return out;
	};
	const reached = new Set<string>();
	const walk = (id: string) => {
		if (reached.has(id) || !ids.has(id)) {
			return;
		}
		reached.add(id);
		const i = ids.get(id)!;
		for (const ref of references(build.ui.components[i]!)) {
			if (!ids.has(ref)) {
				error('a2ui-missing-component', `/ui/components/${i}`, `"${id}" refers to a missing component "${ref}".`);
			}
			walk(ref);
		}
	};
	walk('root');
	const unreached = [...ids.keys()].filter((id) => !reached.has(id));
	if (unreached.length) {
		error('a2ui-unreachable', '/ui/components', `Components not reachable from "root": ${unreached.join(', ')}.`);
	}

	// Values anywhere: known functions with valid arguments, pointers, events sent.
	const sent = new Set<string>();
	const scan = (item: unknown, path: string) => {
		if (Array.isArray(item)) {
			item.forEach((inner, i) => scan(inner, `${path}/${i}`));
			return;
		}
		if (!isObject(item)) {
			return;
		}
		if (isCall(item)) {
			const fn = catalog.functions.get(item.call);
			if (!fn) {
				error('a2ui-unknown-function', path, `"${item.call}" is not a function of the ${host.catalogId} catalog.`);
			} else {
				for (const problem of schemaProblems(fn.schema, item.args ?? {})) {
					error('a2ui-function-args', `${path}/args${problem.path ? `/${problem.path}` : ''}`, `${item.call}: ${problem.message}.`);
				}
			}
		}
		if (isBinding(item) && dotted(item.path)) {
			error('a2ui-dotted-pointer', path, `"${item.path}" is not a JSON Pointer: keys are separated with "/", e.g. "${item.path.replace(/\./g, '/')}".`);
		}
		const event = (item as Record<string, unknown>).event;
		if (isObject(event) && typeof event.name === 'string') {
			sent.add(event.name);
		}
		for (const [key, inner] of Object.entries(item)) {
			scan(inner, `${path}/${key}`);
		}
	};

	build.ui.components.forEach((component, i) => {
		const path = `/ui/components/${i}`;
		const api = catalog.components.get(component.component);
		if (!api) {
			error('a2ui-unknown-component', `${path}/component`, `"${component.component}" is not in the ${host.catalogId} catalog (${[...catalog.components.keys()].join(', ')}).`);
		} else {
			for (const problem of schemaProblems(api.schema, component)) {
				error('a2ui-props', `${path}${problem.path ? `/${problem.path}` : ''}`, `${component.component} "${component.id}": ${problem.message}.`);
			}
		}
		if (INPUT_COMPONENTS.has(component.component) && !(isBinding(component.value) && component.value.path.startsWith('/'))) {
			error('a2ui-input-binding', `${path}/value`, `The input "${component.id}" must bind "value" to an absolute pointer, e.g. {"path": "/form/${component.id}"}.`);
		}
		if (component.component === 'Table') {
			((component.fields as Array<{ id?: unknown }> | undefined) ?? []).forEach((field, f) => {
				if (typeof field.id === 'string' && dotted(field.id)) {
					error('a2ui-dotted-pointer', `${path}/fields/${f}/id`, `Field "${field.id}" is not a JSON Pointer into the row: use "${field.id.replace(/\./g, '/')}".`);
				}
			});
		}
		scan(component, path);
	});

	// The data model's top level: data sources, the slot, `initial` and `computed`.
	for (const section of ['initial', 'computed'] as const) {
		scan(build.ui[section] ?? {}, `/ui/${section}`);
	}
	const keys = [...Object.keys(build.ui.initial ?? {}), ...Object.keys(build.ui.computed ?? {})];
	for (const key of keys) {
		if (key === 'slot' || Object.hasOwn(build.data, key) || keys.indexOf(key) !== keys.lastIndexOf(key)) {
			error('a2ui-model-key', '/ui', `The data model key "${key}" is used twice: data sources, "slot", "initial" and "computed" share the top level.`);
		}
	}

	// Events: every one sent is bound, every bound one is sent, and each is a valid call.
	for (const name of sent) {
		if (!build.events[name]) {
			error('a2ui-unbound-event', '/events', `The event "${name}" is not bound in "events".`);
		}
	}
	for (const [name, binding] of Object.entries(build.events)) {
		const path = `/events/${name}`;
		if (!sent.has(name)) {
			error('a2ui-unused-event', path, `The event "${name}" is bound but nothing sends it.`);
		}
		const capability = surface.capabilities[binding.call];
		if (!capability) {
			error('build-unknown-capability', `${path}/call`, `Unknown capability "${binding.call}".`);
			continue;
		}
		// Scopes the spec does not request: core checks refs, which include these calls (a warning when upgrading).
		for (const problem of inputProblems(surface, binding.call, binding.input ?? {})) {
			error('build-invalid-value', `${path}/input`, `Input for "${binding.call}": ${problem}.`);
		}
		(binding.then ?? []).forEach((op, i) => {
			const [kind, target] = op.split(':');
			const ok = (kind === 'reload' && target === 'page') || ((kind === 'refresh' || kind === 'remove-row') && target !== undefined && Object.hasOwn(build.data, target));
			if (!ok) {
				error('build-unknown-data', `${path}/then/${i}`, `"${op}" is not "refresh:<source>", "remove-row:<source>" or "reload:page".`);
			}
		});
	}

	// `can` checks scopes the surface has.
	const scopes = new Set<string>();
	collectScopes(build.ui, scopes);
	for (const scope of scopes) {
		if (!surface.scopes[scope]) {
			error('build-unknown-scope', '/ui', `Unknown scope "${scope}" in a "can" call.`);
		}
	}
	return diagnostics;
}

/** Scopes named by `can` calls anywhere in a value. */
export function collectScopes(value: unknown, into: Set<string>): Set<string> {
	if (Array.isArray(value)) {
		value.forEach((item) => collectScopes(item, into));
	} else if (isObject(value)) {
		if (value.call === 'can' && isObject(value.args) && typeof value.args.scope === 'string') {
			into.add(value.args.scope);
		}
		Object.values(value).forEach((item) => collectScopes(item, into));
	}
	return into;
}
