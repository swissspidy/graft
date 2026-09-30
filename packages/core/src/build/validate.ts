import type { SchemaError as ErrorObject, Validator } from '../schema.ts';
import buildSchema from '../../../../schemas/build.schema.json' with { type: 'json' };
import '../ajv.ts';
import { compileSchema, lazyValidator } from '../schema.ts';
import { hasErrors, type Diagnostic } from '../diagnostics.ts';
import { describeSchemaError, schemaErrorPath } from '../schema-errors.ts';
import type { Spec } from '../spec/types.ts';
import { hashSurface } from '../surface/hash.ts';
import type { JsonSchema, Surface } from '../surface/types.ts';
import { isDynamic, isCall, isCan, isDataRef, isFn, isInputRef, isSlotRef, walkTree, walkValue } from './expressions.ts';
import { extractRefs } from './refs.ts';
import { isWidgetEvent, isWidgetUse, WIDGET } from './widgets.ts';
import type { Build, Refs, TreeNode, Value } from './types.ts';

const validateShape = lazyValidator<Build>(buildSchema);

export interface BuildValidation {
	ok: boolean;
	/** Present when there are no errors. */
	build?: Build;
	/** Refs computed from the build's content, present when the shape is valid. */
	refs?: Refs;
	diagnostics: Diagnostic[];
}

export interface ValidateBuildOptions {
	/**
	 * The spec version the build claims to implement. When given, the spec
	 * id, criteria coverage and requested scopes are checked too.
	 */
	spec?: { spec: Spec; hash: string };
	/**
	 * Validating an upgrade candidate: the mount may differ from the spec's
	 * (re-anchored), and scopes the spec does not request are warnings (the
	 * candidate needs approval) instead of errors.
	 */
	upgrade?: boolean;
}

/**
 * Validates a build against the surface it targets: shape, every symbol it
 * uses, component props and capability inputs (with bindings exempted),
 * data source and then-op references, check coverage, and that its stored
 * refs match the refs computed from its content.
 */
export async function validateBuild(value: unknown, surface: Surface, options: ValidateBuildOptions = {}): Promise<BuildValidation> {
	if (!validateShape(value)) {
		return {
			ok: false,
			diagnostics: (validateShape.errors ?? []).map((error) => ({
				severity: 'error',
				code: 'build-schema',
				message: describeSchemaError(error, '', 'The build'),
				path: schemaErrorPath(error) || '/',
			})),
		};
	}
	const build = value;
	const diagnostics: Diagnostic[] = [];
	const error = (code: string, path: string, message: string) => diagnostics.push({ severity: 'error', code, path, message });

	// Target surface.
	const surfaceHash = surface.hash ?? (await hashSurface(surface));
	if (build.surface.host !== surface.host || build.surface.hash !== surfaceHash) {
		error('build-surface-mismatch', '/surface', `The build targets ${build.surface.host} surface ${build.surface.hash}, not ${surface.host} ${surfaceHash}.`);
	}

	// Mount.
	const slot = surface.slots[build.mount.slot];
	if (!slot) {
		error('build-unknown-slot', '/mount/slot', `Unknown slot "${build.mount.slot}".`);
	} else if (slot.accepts && !slot.accepts.includes(build.tree.type)) {
		error('build-root-not-accepted', '/tree/type', `Slot "${build.mount.slot}" only accepts ${slot.accepts.join(', ')} at the root, not "${build.tree.type}".`);
	}
	const slotProps = slot && typeof slot.provides === 'object' ? Object.keys((slot.provides.properties as object | undefined) ?? {}) : [];

	// Code: pure functions, only where the host can run them.
	const functions = new Set(build.code?.functions ?? []);
	if (build.code) {
		checkCode(build, surface, error);
	}
	const noFunctionsIn = (root: Value | undefined, base: string, what: string) =>
		walkValue(root, base, (item, path) => {
			if (isFn(item)) {
				error('build-fn-not-allowed', path, `${what} cannot use $fn: functions only compute values to show, never what is read or written.`);
			}
		});

	// $input only where a widget's declared action reads what the viewer sees.
	const inputAllowed = /^\/props\/actions\/[^/]+\/call\/input(\/|$)/;
	const widgetPaths: string[] = [];

	// Expressions anywhere in the build.
	const checkExpressions = (root: Value | undefined, base: string) =>
		walkValue(root, base, (item, path) => {
			if (isInputRef(item) && !widgetPaths.some((widget) => path.startsWith(widget) && inputAllowed.test(path.slice(widget.length)))) {
				error('build-input-not-allowed', path, `"$input" only reads an input in a widget's declared actions (props.actions.<name>.call.input).`);
			}
			if (isFn(item)) {
				if (!surface.functions) {
					error('build-functions-unsupported', path, `${surface.host} does not run build functions, so "$fn" cannot be used.`);
				} else if (!functions.has(item.$fn)) {
					error('build-unknown-function', path, `"${item.$fn}" is not one of the build's functions (${[...functions].join(', ') || 'none'}).`);
				}
			}
			if (isDataRef(item) && !Object.hasOwn(build.data, item.$data.split('.')[0] ?? '')) {
				error('build-unknown-data', path, `"${item.$data}" does not start with a declared data source (${Object.keys(build.data).join(', ') || 'none'}).`);
			}
			if (isSlotRef(item) && !slotProps.includes(item.$slot.split('.')[0] ?? '')) {
				error('build-unknown-slot-prop', path, `Slot "${build.mount.slot}" does not provide "${item.$slot}".`);
			}
			if (isCan(item) && !surface.scopes[item.$can]) {
				error('build-unknown-scope', path, `Unknown scope "${item.$can}".`);
			}
			if (isCall(item)) {
				const capability = surface.capabilities[item.$call];
				if (!capability) {
					error('build-unknown-capability', path, `Unknown capability "${item.$call}".`);
				} else if (item.input !== undefined) {
					checkAgainstSchema(capability.input, item.input, `${path}/input`, `Input for "${item.$call}"`, diagnostics);
				}
				noFunctionsIn(item.input, `${path}/input`, `The input for "${item.$call}"`);
				item.then?.forEach((op, i) => {
					const [kind, target] = op.split(':');
					if ((kind === 'refresh' || kind === 'remove-row') && !Object.hasOwn(build.data, target ?? '')) {
						error('build-unknown-data', `${path}/then/${i}`, `"${op}" names an undeclared data source.`);
					}
				});
			}
		});

	// Tree.
	walkTree(build.tree, '/tree', (node, path) => {
		const component = surface.components[node.type];
		if (!component) {
			error('build-unknown-component', `${path}/type`, `Unknown component "${node.type}".`);
			return;
		}
		const children = component.children ?? 'none';
		if (node.children !== undefined) {
			if (children === 'none') {
				error('build-children', `${path}/children`, `"${node.type}" takes no children.`);
			} else if (children === 'text' && typeof node.children !== 'string') {
				error('build-children', `${path}/children`, `"${node.type}" takes text, not nodes.`);
			}
		}
		checkAgainstSchema(component.props, node.props ?? {}, `${path}/props`, `Props of "${node.type}"`, diagnostics);
		if (node.type === WIDGET) {
			widgetPaths.push(path);
		}
		checkExpressions(node.props as Value | undefined, `${path}/props`);
		if (node.type === WIDGET) {
			if (!surface.functions?.widgets) {
				error('build-widgets-unsupported', `${path}/type`, `${surface.host} does not run interactive widgets.`);
			}
			for (const prop of ['render', 'update'] as const) {
				const name = node.props?.[prop];
				if (name !== undefined && (typeof name !== 'string' || !functions.has(name))) {
					error('build-unknown-function', `${path}/props/${prop}`, `The widget's ${prop} must name one of the build's functions (${[...functions].join(', ') || 'none'}).`);
				}
			}
		}
	});

	// Data sources.
	for (const [name, source] of Object.entries(build.data)) {
		const path = `/data/${name}`;
		const capability = surface.capabilities[source.call];
		if (!capability) {
			error('build-unknown-capability', `${path}/call`, `Unknown capability "${source.call}".`);
			continue;
		}
		if (capability.kind !== 'read') {
			error('build-data-not-read', `${path}/call`, `Data source "${name}" uses "${source.call}", which writes. Data sources must only read.`);
		}
		checkAgainstSchema(capability.input, source.input ?? null, `${path}/input`, `Input for "${source.call}"`, diagnostics, source.input === undefined);
		checkExpressions(source.input, `${path}/input`);
		noFunctionsIn(source.input, `${path}/input`, `Data source "${name}"`);
	}

	// Refs are computed, never trusted.
	const refs = extractRefs(build, surface);
	if (JSON.stringify(refs) !== JSON.stringify(build.refs)) {
		error('build-refs-mismatch', '/refs', 'The stored refs do not match the build content. Recompute them (graft build --fix-refs).');
	}

	// Against the spec.
	if (options.spec) {
		const { spec, hash } = options.spec;
		if (build.spec.id !== spec.manifest.id || build.spec.hash !== hash) {
			error('build-spec-mismatch', '/spec', `The build is for ${build.spec.id} ${build.spec.hash}, not ${spec.manifest.id} ${hash}.`);
		}
		if (build.mount.slot !== spec.manifest.mount.slot && !options.upgrade) {
			error('build-spec-mismatch', '/mount/slot', `The spec mounts at "${spec.manifest.mount.slot}", the build at "${build.mount.slot}".`);
		}
		for (const scope of refs.scopes) {
			if (!spec.manifest.permissions.includes(scope)) {
				diagnostics.push({
					severity: options.upgrade ? 'warning' : 'error',
					code: 'build-scope-not-requested',
					path: '/refs/scopes',
					message: `The build needs "${scope}", which the spec does not request.`,
				});
			}
		}
		const criteria = new Set(spec.criteria.map((c) => c.id));
		build.checks.forEach((check, i) => {
			if (!criteria.has(check.criterion)) {
				error('build-unknown-criterion', `/checks/${i}/criterion`, `No acceptance criterion "${check.criterion}" in the spec.`);
			}
		});
		for (const criterion of spec.criteria) {
			if (!build.checks.some((check) => check.criterion === criterion.id)) {
				diagnostics.push({
					severity: 'warning',
					code: 'build-criterion-unchecked',
					path: '/checks',
					message: `Criterion "${criterion.id}" has no check, so nothing verifies it.`,
				});
			}
		}
	}

	if (hasErrors(diagnostics)) {
		return { ok: false, refs, diagnostics };
	}
	return { ok: true, build, refs, diagnostics };
}

/** The build's code fits the surface's limits and declares the functions it lists. */
function checkCode(build: Build, surface: Surface, error: (code: string, path: string, message: string) => void): void {
	const code = build.code!;
	if (!surface.functions) {
		error('build-functions-unsupported', '/code', `${surface.host} does not run build functions, so the build cannot carry code.`);
		return;
	}
	const bytes = new TextEncoder().encode(code.source).length;
	if (bytes > surface.functions.limits.sourceBytes) {
		error('build-code-too-large', '/code/source', `The code is ${bytes} bytes; ${surface.host} runs at most ${surface.functions.limits.sourceBytes}.`);
	}
	code.functions.forEach((name, i) => {
		if (!new RegExp(`(^|[^.\\w$])function\\s+${name.replace(/\$/g, '\\$')}\\s*\\(`).test(code.source)) {
			error('build-unknown-function', `/code/functions/${i}`, `The code does not declare "function ${name}(...)".`);
		}
	});
}

/**
 * Validates a value that may contain binding expressions. Bindings are
 * swapped for null, and errors located at a binding (or inside one) are
 * dropped: their values are only known at runtime.
 */
function checkAgainstSchema(
	schema: JsonSchema,
	value: unknown,
	base: string,
	what: string,
	diagnostics: Diagnostic[],
	absent = false,
): void {
	if (absent) {
		value = undefined;
	}
	const bindingPaths: string[] = [];
	const replaced = replaceBindings(value, '', bindingPaths);
	const validate = compile(schema);
	if (replaced === undefined || validate(replaced)) {
		return;
	}
	for (const e of validate.errors ?? []) {
		const at = schemaErrorPath(e);
		if (bindingPaths.some((p) => at === p || at.startsWith(`${p}/`)) || underBindingAlternative(e, bindingPaths)) {
			continue;
		}
		diagnostics.push({
			severity: 'error',
			code: 'build-invalid-value',
			path: base + at,
			message: `${what}: ${describeSchemaError(e, '', 'value')}`,
		});
	}
}

/** anyOf/oneOf errors are reported on the parent; drop them when a binding sits directly there. */
function underBindingAlternative(error: ErrorObject, bindingPaths: string[]): boolean {
	return (error.keyword === 'anyOf' || error.keyword === 'oneOf') && bindingPaths.includes(error.instancePath);
}

function replaceBindings(value: unknown, path: string, found: string[]): unknown {
	// Widget events stand where actions go; only code can produce them.
	if (isDynamic(value) || isWidgetEvent(value) || isWidgetUse(value)) {
		found.push(path);
		return null;
	}
	if (Array.isArray(value)) {
		return value.map((item, i) => replaceBindings(item, `${path}/${i}`, found));
	}
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, replaceBindings(item, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, found)]),
		);
	}
	return value;
}

function compile(schema: JsonSchema): Validator {
	return compileSchema(schema);
}

/**
 * Checks a tree a widget drew against the surface, as a build's tree is
 * checked: known components, children rules, and props against their
 * schemas (event markers stand where actions go). Returns plain-language
 * problems.
 */
export function validateWidgetTree(tree: TreeNode, surface: Surface): string[] {
	const diagnostics: Diagnostic[] = [];
	walkTree(tree, '', (node, path) => {
		const component = surface.components[node.type];
		if (!component) {
			diagnostics.push({ severity: 'error', code: 'widget-unknown-component', path, message: `Unknown component "${node.type}".` });
			return;
		}
		const children = component.children ?? 'none';
		if (node.children !== undefined && (children === 'none' || (children === 'text' && typeof node.children !== 'string'))) {
			diagnostics.push({ severity: 'error', code: 'widget-children', path, message: `"${node.type}" does not take these children.` });
		}
		checkAgainstSchema(component.props, node.props ?? {}, `${path}/props`, `Props of "${node.type}"`, diagnostics);
	});
	return diagnostics.map((d) => `${d.path ? `${d.path}: ` : ''}${d.message}`);
}
