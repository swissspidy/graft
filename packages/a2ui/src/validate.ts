import { isSafeRegex, type Catalog, type ComponentApi } from '@a2ui/web_core/v0_9';
import { compileSchema, type Build, type Diagnostic, type Surface } from '@swissspidy/graft-core';
import type { z } from 'zod';
import { createGraftCatalog, INPUT_COMPONENTS } from './catalog.ts';
import { writesLoaded, type A2UIHost } from './walk.ts';
import type { A2UIBuild, A2UIComponent } from './types.ts';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isBinding = (value: unknown): value is { path: string } => isObject(value) && typeof value.path === 'string' && Object.keys(value).length === 1;
const isCall = (value: unknown): value is { call: string; args?: Record<string, unknown> } => isObject(value) && typeof value.call === 'string' && Object.keys(value).every((k) => ['call', 'args', 'returnType'].includes(k));
const isDynamic = (value: unknown) => isBinding(value) || isCall(value);

const compiles = (pattern: string): boolean => {
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
};

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
export function validateA2UI(value: Build, surface: Surface, host: A2UIHost): Diagnostic[] {
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

	const loaded = new Set(['slot', ...Object.keys(build.data ?? {})]);

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
				// web_core refuses to run a pattern that can backtrack catastrophically; the call would have no value.
				const pattern = item.args?.pattern;
				if ((item.call === 'regex' || item.call === 'replace') && isDynamic(pattern)) {
					error('a2ui-function-args', `${path}/args/pattern`, `${item.call}: "pattern" must be written out as a string, not read from data.`);
				} else if (item.call === 'replace' && typeof pattern === 'string' && !compiles(pattern)) {
					error('a2ui-function-args', `${path}/args/pattern`, `replace: "${pattern}" is not a regular expression.`);
				} else if ((item.call === 'regex' || item.call === 'replace') && typeof pattern === 'string' && !isSafeRegex(pattern)) {
					error(
						'a2ui-unsafe-pattern',
						`${path}/args/pattern`,
						`${item.call}: "${pattern}" can backtrack catastrophically (ReDoS), so the renderer refuses to run it. Anchor it at the start (e.g. "^\\s*\\S+\\s+\\S" rather than "\\S+\\s+\\S") and avoid quantified parts that can match the same text.`,
					);
				}
				if (item.call === 'can' && isDynamic(item.args?.scope)) {
					error('a2ui-function-args', `${path}/args/scope`, 'can: "scope" must be written out as a string, not read from data.');
				}
				// A template's calls are not objects, so nothing here can check them: keep the ones that need checking out.
				const template = item.call === 'formatString' ? item.args?.value : undefined;
				const hidden = typeof template === 'string' ? /\$\{\s*(can|regex|replace|set)\s*\(/.exec(template) : null;
				if (hidden) {
					error('a2ui-template-call', `${path}/args/value`, `formatString: "${hidden[1]}" cannot be called inside a template. Call it as {"call": "${hidden[1]}", ...} and put the result in the data model ("computed"), then interpolate its path.`);
				}
				if (item.call === 'set' && typeof item.args?.target === 'string' && item.args.target.startsWith('/') && writesLoaded(item.args.target, loaded)) {
					error('a2ui-model-key', `${path}/args/target`, `"${item.args.target}" is loaded by the host (a data source or the slot), so "set" cannot write to it. Use a key of its own, e.g. "/form/...".`);
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
			const { id: _id, component: _type, catalogId: _catalog, ...props } = component as A2UIComponent & { catalogId?: unknown };
			for (const problem of schemaProblems(api.schema, props)) {
				error('a2ui-props', `${path}${problem.path ? `/${problem.path}` : ''}`, `${component.component} "${component.id}": ${problem.message}.`);
			}
		}
		if (INPUT_COMPONENTS.has(component.component) && !(isBinding(component.value) && component.value.path.startsWith('/'))) {
			error('a2ui-input-binding', `${path}/value`, `The input "${component.id}" must bind "value" to an absolute pointer, e.g. {"path": "/form/${component.id}"}.`);
		} else if (INPUT_COMPONENTS.has(component.component) && writesLoaded((component.value as { path: string }).path, loaded)) {
			error('a2ui-input-binding', `${path}/value`, `The input "${component.id}" writes to "${(component.value as { path: string }).path}", which the host loads (a data source or the slot). Bind it to a key of its own, e.g. {"path": "/form/${component.id}"}, and start it from the loaded value in "initial".`);
		}
		const validation = component.validationRegexp;
		if (component.component === 'TextField' && typeof validation === 'string' && !isSafeRegex(validation)) {
			error('a2ui-unsafe-pattern', `${path}/validationRegexp`, `"${validation}" can backtrack catastrophically (ReDoS), so the renderer refuses to run it and the field would never be valid.`);
		}
		if (component.component === 'Table') {
			const labels = new Set<unknown>();
			((component.fields as Array<{ id?: unknown; label?: unknown }> | undefined) ?? []).forEach((field, f) => {
				if (typeof field.id === 'string' && dotted(field.id)) {
					error('a2ui-dotted-pointer', `${path}/fields/${f}/id`, `Field "${field.id}" is not a JSON Pointer into the row: use "${field.id.replace(/\./g, '/')}".`);
				}
				if (typeof field.label === 'string' && labels.has(field.label)) {
					error('a2ui-duplicate-label', `${path}/fields/${f}/label`, `Two columns of "${component.id}" are labelled "${field.label}": a check names a column by its label.`);
				}
				labels.add(field.label);
			});
		}
		const listed = Array.isArray(component.children) ? component.children.map(String) : [];
		const twice = listed.find((child, c) => listed.indexOf(child) !== c);
		if (twice !== undefined) {
			error('a2ui-duplicate-reference', `${path}/children`, `"${component.id}" lists the child "${twice}" twice: a component is drawn once in a place.`);
		}
		scan(component, path);
	});

	diagnostics.push(...dragProblems(build.ui.components));

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
		if (!Object.hasOwn(build.events, name)) {
			error('a2ui-unbound-event', '/events', `The event "${name}" is not bound in "events".`);
		}
	}
	for (const [name, binding] of Object.entries(build.events)) {
		const path = `/events/${name}`;
		if (!sent.has(name)) {
			error('a2ui-unused-event', path, `The event "${name}" is bound but nothing sends it.`);
		}
		if (!Object.hasOwn(surface.capabilities, binding.call)) {
			error('build-unknown-capability', `${path}/call`, `Unknown capability "${binding.call}".`);
			continue;
		}
		// Scopes the spec does not request: core checks refs, which include these calls (a warning when upgrading).
		for (const problem of inputProblems(surface, binding.call, binding.input ?? {})) {
			error('build-invalid-value', `${path}/input`, `Input for "${binding.call}": ${problem}.`);
		}
		(binding.then ?? []).forEach((op, i) => {
			const [kind, target, ...rest] = op.split(':');
			const ok = rest.length === 0 && ((kind === 'reload' && target === 'page') || ((kind === 'refresh' || kind === 'remove-row') && target !== undefined && Object.hasOwn(build.data, target)));
			if (!ok) {
				error('build-unknown-data', `${path}/then/${i}`, `"${op}" is not "refresh:<source>", "remove-row:<source>" or "reload:page".`);
			}
		});
	}

	// What a row writes cannot start as a literal: `initial` would name a row of some other site's data.
	for (const target of rowWrittenTargets(build.ui)) {
		const start = pointerIn(build.ui.initial, target);
		if (start !== undefined && start !== null && start !== '' && start !== 0 && start !== false) {
			error(
				'a2ui-initial-row-value',
				`/ui/initial${target}`,
				`"${target}" is set from a row, so it cannot start as ${JSON.stringify(start)}: that value comes from data this build was written against, not the site's. Start it empty (null).`,
			);
		}
	}

	// `can` checks scopes the surface has.
	const scopes = new Set<string>();
	collectScopes(build.ui, scopes);
	for (const scope of scopes) {
		if (!Object.hasOwn(surface.scopes, scope)) {
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

/**
 * State a host kept outside itself (in the page, in a button's value),
 * cut down to what the build's own `set` actions can write: the pointers
 * they target. Anything else in it was not put there by the build.
 */
export function localState(build: A2UIBuild, state: Record<string, unknown>): Record<string, unknown> {
	const targets = new Set<string>();
	const collect = (value: unknown): void => {
		if (Array.isArray(value)) {
			value.forEach(collect);
		} else if (isObject(value)) {
			if (value.call === 'set' && isObject(value.args) && typeof value.args.target === 'string') {
				targets.add(value.args.target);
			}
			Object.values(value).forEach(collect);
		}
	};
	collect(build.ui.components);
	return Object.fromEntries(Object.entries(state).filter(([pointer]) => targets.has(pointer)));
}

/** Pointers a local `set` writes from a row's own field ({"path": "id"} in a row's scope). */
function rowWrittenTargets(value: unknown, into = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		value.forEach((item) => rowWrittenTargets(item, into));
	} else if (isObject(value)) {
		const args = value.call === 'set' && isObject(value.args) ? value.args : undefined;
		if (args && typeof args.target === 'string' && isBinding(args.value) && !args.value.path.startsWith('/')) {
			into.add(args.target);
		}
		Object.values(value).forEach((item) => rowWrittenTargets(item, into));
	}
	return into;
}

/** The value at an absolute JSON Pointer, or undefined. */
function pointerIn(value: unknown, pointer: string): unknown {
	return pointer
		.split('/')
		.slice(1)
		.map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
		.reduce<unknown>((at, key) => (isObject(at) || Array.isArray(at) ? (at as Record<string, unknown>)[key] : undefined), value);
}

/**
 * Dragging presses a Button: every Button with a `dropTarget` is inside a
 * draggable Card and names a container that takes drops, and every
 * draggable Card has a Button to press.
 */
function dragProblems(components: A2UIComponent[]): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const byId = new Map(components.map((component, i) => [component.id, { component, i }]));
	const zones = new Set(components.filter((c) => c.component !== 'Button' && typeof c.dropTarget === 'string').map((c) => String(c.dropTarget)));
	const error = (i: number, at: string, message: string) => diagnostics.push({ severity: 'error', code: 'a2ui-drag', path: `/ui/components/${i}${at}`, message });
	const pressed = new Set<string>();
	const seen = new Set<string>();
	// From the root, with the draggable Card each component is inside, if any.
	const walk = (id: string, card: string | undefined) => {
		const entry = byId.get(id);
		if (!entry || seen.has(`${id}@${card ?? ''}`)) {
			return;
		}
		seen.add(`${id}@${card ?? ''}`);
		const { component, i } = entry;
		const inside = component.component === 'Card' && component.draggable !== undefined && component.draggable !== false ? id : card;
		if (component.component === 'Button' && typeof component.dropTarget === 'string') {
			if (!card) {
				error(i, '/dropTarget', `The button "${id}" has a "dropTarget" but is not inside a Card with "draggable": nothing is dragged to press it.`);
			} else {
				pressed.add(card);
			}
			if (!zones.has(component.dropTarget)) {
				error(i, '/dropTarget', `The button "${id}" is pressed by a drop on "${component.dropTarget}", but no Column, Row or Card has that "dropTarget"${zones.size ? ` (${[...zones].join(', ')})` : ''}.`);
			}
		}
		const children = component.children;
		const refs = Array.isArray(children) ? children.map(String) : isObject(children) && typeof children.componentId === 'string' ? [children.componentId] : [];
		if (typeof component.child === 'string') {
			refs.push(component.child);
		}
		refs.forEach((ref) => walk(ref, inside));
	};
	walk('root', undefined);
	for (const { component, i } of byId.values()) {
		if (component.component === 'Card' && component.draggable !== undefined && component.draggable !== false && !pressed.has(component.id)) {
			error(i, '/draggable', `The card "${component.id}" is draggable but has no Button with a "dropTarget": dropping it would do nothing.`);
		}
	}
	return diagnostics;
}
