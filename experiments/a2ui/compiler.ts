import { describeSpec, describeSurface, usableCapabilities, type Check, type ModelClient, type Spec, type Surface, type Verification } from '../../packages/core/src/index.ts';
import { compileSchema } from '../../packages/core/src/schema.ts';
import { describeSchemaError, schemaErrorPath } from '../../packages/core/src/schema-errors.ts';
import { isDataBinding, isFunctionCall, type ComponentDefinition } from '../../packages/a2ui/src/core/index.ts';
import { CATALOG_GUIDE, CATALOG_ID, COMPONENTS, graftFunctions, PROTOCOL } from './catalog.ts';
import type { A2UIBuild, EventBinding } from './snapshot.ts';

/**
 * Proof of concept: the compiler's tree phase, emitting an A2UI surface
 * and its event bindings instead of a Graft tree. Checks stay frozen and
 * come from elsewhere; this is only prompt, output schema, assembly and
 * static validation. A2UI's component list is already flat, so it maps
 * onto structured outputs (no recursive schemas) without reshaping.
 */

const names = (values: readonly string[]) => (values.length > 0 ? { type: 'string', enum: [...values] } : { type: 'string' });

export function a2uiOutputSchema(spec: Spec, surface: Surface): Record<string, unknown> {
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
						component: names(COMPONENTS),
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

/** The surface without Graft's tree components: the A2UI catalog replaces them. */
function describeHost(spec: Spec, surface: Surface): string {
	return describeSurface(spec, surface).replace(/\nComponents \(props[\s\S]*?(?=\nCapabilities you may use)/, '');
}

const WORDPRESS_NOTES = `WordPress specifics:
- posts.list returns {items: [{id, title, status, type, author: {id, name}, date, modified, edit_url, meta, terms, can: {edit, publish}}], total, pages}. Bind table rows to /<source>/items.
- Per-post permission: {"call": "can", "args": {"scope": "posts.status:write"}} in a table row uses that row's post; for the slot's post pass "on": {"path": "/slot/post"}.
- The post.editor.panel slot renders in the block editor's sidebar for each saved post the viewer can edit, with /slot/post = {id, title, excerpt, status, type, meta, terms, can} (title and excerpt as saved). Events that change the post should end with "then": ["reload:page"], which reloads the editor (and with it the saved values and the form). Checks match its actions and inputs with "row": {"title": ...}, which refers to that post.
- The posts.list.row-actions slot renders once per post on the posts list screen, with /slot/post = {id, title, status, type, meta, terms, can}; its root is the one Button for that post (its id is the action id). WordPress draws that list, so its events end with "then": ["reload:page"].
- The dashboard.widget slot is a Dashboard box with no slot data: draw from data sources.
- posts.update_fields changes a post's title and/or excerpt (scope posts:write). posts.update_status changes its status (scope posts.status:write).`;

export function a2uiSystem(spec: Spec, surface: Surface): string {
	return [
		'You build customizations of a web application as A2UI surfaces. The surface may only use the components and functions of the catalog below, the slot\'s data and the capabilities listed; it is drawn by a trusted renderer and every capability call is permission-checked. Keep it minimal: build what the spec asks, nothing it puts out of scope.',
		CATALOG_GUIDE,
		WORDPRESS_NOTES,
		describeHost(spec, surface),
	].join('\n\n');
}

export function a2uiPrompt(spec: Spec, checks: Check[], feedback: string[], previous?: A2UIBuild): string {
	const lines = [
		'Build this spec. Your build must pass these frozen checks. Action ids in the checks are Button component ids or table row action ids; input ids are TextField and CheckBox component ids. "available": false means hidden or disabled.',
		'',
		describeSpec(spec),
		'',
		`Checks: ${JSON.stringify(checks)}`,
	];
	if (previous) {
		lines.push(
			'',
			'This replaces an earlier build of the same spec that no longer fits the host. Keep its layout and wording where the parts still exist:',
			JSON.stringify({ ui: previous.ui, data: previous.data, events: previous.events }),
		);
	}
	if (feedback.length > 0) {
		lines.push('', 'Your previous attempt was rejected:', ...feedback.map((f) => `- ${f}`), 'Fix these problems and return the complete build.');
	}
	return lines.join('\n');
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parse(text: unknown, what: string, problems: string[]): unknown {
	try {
		return JSON.parse(String(text)) as unknown;
	} catch (error) {
		problems.push(`${what} is not valid JSON: ${(error as Error).message}.`);
		return undefined;
	}
}

type Parts = Pick<A2UIBuild, 'ui' | 'data' | 'events'>;

/** Turns the model's output into the build's `ui`, `data` and `events`. */
export function assembleA2UI(output: unknown): { value?: Parts; problems: string[] } {
	const problems: string[] = [];
	if (!isObject(output) || !Array.isArray(output.components) || !Array.isArray(output.data) || !Array.isArray(output.events)) {
		return { problems: ['The output must have "components", "data" and "events" arrays.'] };
	}
	const components: ComponentDefinition[] = [];
	for (const item of output.components as Array<{ id: string; component: string; props_json: string }>) {
		const props = parse(item.props_json, `Properties of "${item.id}"`, problems);
		if (props !== undefined && !isObject(props)) {
			problems.push(`Properties of "${item.id}" must be an object.`);
			continue;
		}
		const { id: _id, component: _component, ...rest } = (props ?? {}) as Record<string, unknown>;
		components.push({ id: item.id, component: item.component, ...rest });
	}
	const initial = parse(output.initial_json, 'initial_json', problems);
	if (initial !== undefined && !isObject(initial)) {
		problems.push('initial_json must be an object.');
	}
	const computed = parse(output.computed_json ?? '{}', 'computed_json', problems);
	if (computed !== undefined && !isObject(computed)) {
		problems.push('computed_json must be an object.');
	}
	const data: A2UIBuild['data'] = {};
	for (const item of output.data as Array<{ name: string; call: string; input_json: string }>) {
		if (!/^[a-z][a-zA-Z0-9_-]*$/.test(item.name) || item.name === 'slot' || item.name === 'form') {
			problems.push(`Data source name "${item.name}" must start with a lowercase letter, use letters, digits, _ or -, and not be "slot" or "form".`);
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
	return { value: { ui: { protocol: PROTOCOL, catalogId: CATALOG_ID, ...(isObject(initial) && Object.keys(initial).length ? { initial } : {}), ...(isObject(computed) && Object.keys(computed).length ? { computed } : {}), components }, data, events }, problems };
}

/**
 * Problems with a capability input: checked against the capability's input
 * schema, with placeholders filled in at run time ({"$context": ...} in
 * events, {"$slot": ...} in data sources) exempt.
 */
export function inputProblems(surface: Surface, capability: string, input: unknown, what: string): string[] {
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
			const at = schemaErrorPath(error);
			const exempt = placeholders.some((p) => at === p || at.startsWith(`${p}/`));
			return !exempt && !((error.keyword === 'anyOf' || error.keyword === 'oneOf') && placeholders.includes(error.instancePath));
		})
		.map((error) => `${what}: ${describeSchemaError(error, '', 'the input')}`);
}

/** Pointers written with "." where JSON Pointers use "/" (e.g. "can.publish"). */
function dottedPointer(path: string): boolean {
	return path.split('/').some((segment) => /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(segment));
}

/** Static checks before verification: structure, references, functions, event bindings, capability inputs. */
export function validateA2UI(build: Parts, surface?: Surface): string[] {
	const problems: string[] = [];
	const ids = new Map<string, ComponentDefinition>();
	for (const component of build.ui.components) {
		if (ids.has(component.id)) {
			problems.push(`Component id "${component.id}" is used twice.`);
		}
		ids.set(component.id, component);
	}
	if (!ids.has('root')) {
		problems.push('No component has id "root".');
	}
	const references = (component: ComponentDefinition): string[] => {
		const out: string[] = [];
		const children = component.children as unknown;
		if (Array.isArray(children)) {
			out.push(...children.map(String));
		} else if (isObject(children) && typeof children.componentId === 'string') {
			out.push(children.componentId);
		}
		if (typeof component.child === 'string') {
			out.push(component.child);
		}
		return out;
	};
	const reached = new Set<string>();
	const walk = (id: string) => {
		if (reached.has(id)) {
			return;
		}
		reached.add(id);
		const component = ids.get(id);
		if (!component) {
			return;
		}
		for (const ref of references(component)) {
			if (!ids.has(ref)) {
				problems.push(`"${id}" refers to a missing component "${ref}".`);
			}
			walk(ref);
		}
	};
	walk('root');
	// Labels of buttons are drawn through their child; anything else unreachable is dead.
	const unreached = [...ids.keys()].filter((id) => !reached.has(id));
	if (unreached.length) {
		problems.push(`Components not reachable from "root": ${unreached.join(', ')}.`);
	}

	const known = new Set(Object.keys(graftFunctions({ can: () => false, now: new Date() })));
	const events = new Set<string>();
	const scan = (value: unknown, where: string) => {
		if (Array.isArray(value)) {
			value.forEach((item) => scan(item, where));
		} else if (isObject(value)) {
			if (isFunctionCall(value) && !known.has(value.call)) {
				problems.push(`${where} calls an unknown function "${value.call}".`);
			}
			if (isDataBinding(value) && dottedPointer(value.path)) {
				problems.push(`${where} binds "${value.path}": JSON Pointers separate keys with "/", e.g. "${value.path.replace(/\./g, '/')}".`);
			}
			if (isObject(value.functionCall) && (value.functionCall.call !== 'set' || !isObject(value.functionCall.args) || typeof value.functionCall.args.target !== 'string' || !value.functionCall.args.target.startsWith('/'))) {
				problems.push(`${where}: a local action must be {"functionCall": {"call": "set", "args": {"target": "/<pointer>", "value": ...}}}.`);
			}
			if (isObject(value.event) && typeof value.event.name === 'string') {
				events.add(value.event.name);
			}
			Object.values(value).forEach((inner) => scan(inner, where));
		}
	};
	for (const component of build.ui.components) {
		scan(component, `"${component.id}"`);
		if (component.component === 'Table') {
			for (const field of (component.fields as Array<{ id?: unknown }> | undefined) ?? []) {
				if (typeof field.id === 'string' && field.id.includes('.') && !field.id.includes('/')) {
					problems.push(`"${component.id}": field "${field.id}" should be a JSON Pointer into the row, e.g. "${field.id.replace(/\./g, '/')}".`);
				}
			}
		}
		if ((component.component === 'TextField' || component.component === 'CheckBox') && !(isDataBinding(component.value) && component.value.path.startsWith('/'))) {
			problems.push(`The input "${component.id}" must bind "value" to an absolute path, e.g. {"path": "/form/${component.id}"}.`);
		}
	}
	scan(build.ui.initial ?? {}, '"initial"');
	scan(build.ui.computed ?? {}, '"computed"');
	const keys = [...Object.keys(build.ui.initial ?? {}), ...Object.keys(build.ui.computed ?? {})];
	for (const key of keys) {
		if (key === 'slot' || build.data[key] || keys.indexOf(key) !== keys.lastIndexOf(key)) {
			problems.push(`The data model key "${key}" is used twice (data sources, "slot", "initial" and "computed" share the top level).`);
		}
	}
	if (surface) {
		for (const [name, source] of Object.entries(build.data)) {
			problems.push(...inputProblems(surface, source.call, source.input ?? {}, `Data source "${name}" (${source.call})`));
		}
		for (const [name, binding] of Object.entries(build.events)) {
			problems.push(...inputProblems(surface, binding.call, binding.input ?? {}, `Event "${name}" (${binding.call})`));
		}
	}
	for (const name of events) {
		if (!build.events[name]) {
			problems.push(`The event "${name}" is not bound in "events".`);
		}
	}
	for (const [name, binding] of Object.entries(build.events)) {
		if (!events.has(name)) {
			problems.push(`The event "${name}" is bound but nothing sends it.`);
		}
		for (const op of binding.then ?? []) {
			const [kind, target] = op.split(':');
			if (!(kind === 'reload' && target === 'page') && !((kind === 'refresh' || kind === 'remove-row') && target && build.data[target])) {
				problems.push(`Event "${name}": "${op}" is not "refresh:<source>", "remove-row:<source>" or "reload:page".`);
			}
		}
	}
	return problems;
}

/** What the build uses, for the gateway: like a tree build's refs, with the catalog's types and properties. */
export function a2uiRefs(build: Parts, slot: string, surface: Surface): A2UIBuild['refs'] {
	const catalog: Record<string, string[]> = {};
	for (const { id: _id, component, ...props } of build.ui.components) {
		catalog[component] = [...new Set([...(catalog[component] ?? []), ...Object.keys(props)])].sort();
	}
	const capabilities = [...new Set([...Object.values(build.data).map((d) => d.call), ...Object.values(build.events).map((e) => e.call)])].sort();
	const scopes = [...new Set(capabilities.flatMap((name) => surface.capabilities[name]?.scopes ?? []))].sort();
	return { slot, catalog, capabilities, scopes } as unknown as A2UIBuild['refs'];
}

export interface CompileA2UIOptions {
	spec: Spec;
	surface: Surface;
	/** The frozen checks. */
	checks: Check[];
	/** The Graft envelope to fill (spec and surface hashes, mount, checks). */
	envelope: Omit<A2UIBuild, 'ui' | 'data' | 'events' | 'refs' | 'provenance'>;
	model: ModelClient;
	verify(build: A2UIBuild): Promise<Verification>;
	/** The build being replaced (regeneration): its surface is the starting point. */
	previous?: A2UIBuild;
	maxAttempts?: number;
	log?(line: string): void;
}

export interface CompileA2UIAttempt {
	attempt: number;
	seconds: number;
	model: string;
	problems: string[];
	results: string;
	output: unknown;
}

/** The tree phase for A2UI: generate, assemble, validate, verify, feed problems back. */
export async function compileA2UI(options: CompileA2UIOptions): Promise<{ ok: boolean; build?: A2UIBuild; attempts: CompileA2UIAttempt[] }> {
	const { spec, surface, checks, model } = options;
	const system = a2uiSystem(spec, surface);
	const schema = a2uiOutputSchema(spec, surface);
	const attempts: CompileA2UIAttempt[] = [];
	let feedback: string[] = [];
	let build: A2UIBuild | undefined;
	for (let attempt = 1; attempt <= (options.maxAttempts ?? 3); attempt++) {
		const started = Date.now();
		const response = await model.generate({ purpose: 'tree', system, prompt: a2uiPrompt(spec, checks, feedback, options.previous), schema });
		const seconds = Math.round((Date.now() - started) / 1000);
		const assembled = assembleA2UI(response.output);
		const problems = assembled.value ? validateA2UI(assembled.value, surface) : assembled.problems;
		let verification: Verification | undefined;
		if (assembled.value && problems.length === 0) {
			build = {
				...options.envelope,
				...assembled.value,
				refs: a2uiRefs(assembled.value, spec.manifest.mount.slot, surface),
				provenance: { compiler: 'a2ui-poc', model: response.model, strategy: options.previous ? 'regenerated' : 'compiled' },
			} as A2UIBuild;
			verification = await options.verify(build);
			problems.push(...verification.results.filter((r) => !r.passed).flatMap((r) => r.failures.map((f) => `Check ${r.check + 1} for "${r.criterion}": ${f}`)));
		}
		const results = verification?.results.map((r) => `${r.passed ? '✔' : '✘'}${r.criterion}#${r.check + 1}`).join(' ') ?? '(not verified)';
		attempts.push({ attempt, seconds, model: response.model, problems, results, output: response.output });
		options.log?.(`attempt ${attempt} (${seconds}s, ${response.model}): ${verification?.passed ? 'passed' : `${problems.length} problems`} ${results}${problems.map((p) => `\n  - ${p}`).join('')}`);
		if (verification?.passed) {
			return { ok: true, build, attempts };
		}
		feedback = problems;
	}
	return { ok: false, ...(build ? { build } : {}), attempts };
}
