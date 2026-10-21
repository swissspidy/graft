import type { SchemaError as ErrorObject, Validator } from '../schema.ts';
import buildSchema from '../../../../schemas/build.schema.json' with { type: 'json' };
import '../ajv.ts';
import { compileSchema, lazyValidator } from '../schema.ts';
import { hasErrors, type Diagnostic } from '../diagnostics.ts';
import { describeSchemaError, schemaErrorPath } from '../schema-errors.ts';
import type { Spec } from '../spec/types.ts';
import { hashSurface } from '../surface/hash.ts';
import type { JsonSchema, Surface } from '../surface/types.ts';
import { isDynamic, isCan, isDataRef, isSlotRef, isTargetRef, walkValue } from './expressions.ts';
import { canonicalJson } from '../surface/hash.ts';
import { intervalSeconds, triggerScopes } from './triggers.ts';
import { extractRefs } from './refs.ts';
import { uiFormatOf } from './format.ts';
import type { Build, Refs, Value } from './types.ts';

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
 * Validates a build against the surface it targets: shape, its UI (by its
 * format), data sources and their inputs (with bindings exempted), check
 * coverage, and that its stored refs match the refs computed from its
 * content.
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
	}
	const slotProps = slot && typeof slot.provides === 'object' ? Object.keys((slot.provides.properties as object | undefined) ?? {}) : [];

	// The UI, in a format that validates it.
	const format = uiFormatOf(build);
	if (!format) {
		error('build-unknown-format', '/ui', `The UI is in a format this tool does not support (${build.ui.protocol}, catalog ${build.ui.catalogId}).`);
		return { ok: false, diagnostics };
	}
	diagnostics.push(...format.validate(build, surface, options.spec?.spec));

	// Expressions in data source inputs.
	const checkExpressions = (root: Value | undefined, base: string) =>
		walkValue(root, base, (item, path) => {
			if (isDataRef(item) && !Object.hasOwn(build.data, item.$data.split('.')[0] ?? '')) {
				error('build-unknown-data', path, `"${item.$data}" does not start with a declared data source (${Object.keys(build.data).join(', ') || 'none'}).`);
			}
			if (isSlotRef(item) && !slotProps.includes(item.$slot.split('.')[0] ?? '')) {
				error('build-unknown-slot-prop', path, `Slot "${build.mount.slot}" does not provide "${item.$slot}".`);
			}
			if (isCan(item) && !surface.scopes[item.$can]) {
				error('build-unknown-scope', path, `Unknown scope "${item.$can}".`);
			}
			if (isTargetRef(item)) {
				error('build-target-outside-trigger', path, `"$target" only reads a trigger's target, in its "where" and "input".`);
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
	}

	// Triggers.
	diagnostics.push(...validateTriggers(build, surface, options));

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
	if (isDynamic(value)) {
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
 * Validates a build's triggers (ADR 0010) against the surface and the
 * spec: the host runs triggers, each trigger is one the spec declares, runs
 * when the spec says, within the host's bounds, calls only capabilities the
 * host lets triggers use, reads only its target, and needs no scope beyond
 * the permissions the spec lists for it.
 */
function validateTriggers(build: Build, surface: Surface, options: ValidateBuildOptions): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const error = (code: string, path: string, message: string) => diagnostics.push({ severity: 'error', code, path, message });
	const triggers = build.triggers ?? {};
	const declared = options.spec?.spec.manifest.triggers ?? {};
	if (options.spec) {
		for (const id of Object.keys(declared)) {
			if (!triggers[id]) {
				error('build-trigger-missing', '/triggers', `The spec declares trigger "${id}", which the build does not implement.`);
			}
		}
	}
	const ids = Object.keys(triggers);
	if (ids.length === 0) {
		return diagnostics;
	}
	const host = surface.triggers;
	if (!host) {
		error('build-triggers-unsupported', '/triggers', `${surface.host} ${surface.hostVersion} does not run triggers.`);
		return diagnostics;
	}

	for (const [id, trigger] of Object.entries(triggers)) {
		const path = `/triggers/${id}`;
		const spec = declared[id];
		if (options.spec && !spec) {
			error('build-trigger-undeclared', path, `The spec declares no trigger "${id}".`);
		}

		// When.
		if (trigger.schedule) {
			const seconds = intervalSeconds(trigger.schedule);
			if (!(seconds >= host.minInterval)) {
				error('build-trigger-too-often', `${path}/schedule/every`, `Triggers run at most every ${host.minInterval / 60} minutes; "${trigger.schedule.every}" is more often.`);
			}
			if (trigger.schedule.at && !trigger.schedule.every.endsWith('d')) {
				error('build-trigger-at', `${path}/schedule/at`, 'A time of day ("at") only goes with a schedule in days.');
			}
		}
		if (trigger.event && !host.events[trigger.event]) {
			error('build-trigger-unknown-event', `${path}/event`, `Unknown event "${trigger.event}". Available: ${Object.keys(host.events).join(', ') || 'none'}.`);
		}
		if (spec && canonicalJson({ schedule: trigger.schedule ?? null, event: trigger.event ?? null }) !== canonicalJson({ schedule: spec.schedule ?? null, event: spec.event ?? null })) {
			// An upgrade may follow the host renaming an event; the spec keeps its old name until it is edited.
			const renamed = options.upgrade && trigger.event !== undefined && spec.event !== undefined;
			diagnostics.push({
				severity: renamed ? 'warning' : 'error',
				code: 'build-trigger-when-mismatch',
				path,
				message: `Trigger "${id}" must run when the spec says (${canonicalJson(spec.schedule ?? spec.event)}).`,
			});
		}

		// What it reads and calls.
		let itemSchema: JsonSchema | undefined;
		if (trigger.targets) {
			const capability = surface.capabilities[trigger.targets.call];
			if (!capability) {
				error('build-unknown-capability', `${path}/targets/call`, `Unknown capability "${trigger.targets.call}".`);
			} else {
				if (capability.kind !== 'read') {
					error('build-data-not-read', `${path}/targets/call`, `Targets come from "${trigger.targets.call}", which writes. Targets must only read.`);
				}
				if (!host.capabilities.includes(trigger.targets.call)) {
					error('build-trigger-capability', `${path}/targets/call`, `Triggers may not use "${trigger.targets.call}". They may use: ${host.capabilities.join(', ')}.`);
				}
				checkAgainstSchema(capability.input, trigger.targets.input ?? null, `${path}/targets/input`, `Input for "${trigger.targets.call}"`, diagnostics, trigger.targets.input === undefined);
				itemSchema = listItemSchema(capability.output, trigger.targets.items ?? 'items');
			}
			walkValue(trigger.targets.input, `${path}/targets/input`, (item, at) => {
				if (isDynamic(item) || isCan(item)) {
					error('build-trigger-expression', at, 'Targets are read with a fixed input: no bindings, permission checks or computed values.');
				}
			});
		} else if (trigger.event) {
			itemSchema = host.events[trigger.event]?.provides;
		}
		const capability = surface.capabilities[trigger.call];
		if (!capability) {
			error('build-unknown-capability', `${path}/call`, `Unknown capability "${trigger.call}".`);
		} else {
			if (!host.capabilities.includes(trigger.call)) {
				error('build-trigger-capability', `${path}/call`, `Triggers may not use "${trigger.call}". They may use: ${host.capabilities.join(', ')}.`);
			}
			checkAgainstSchema(capability.input, trigger.input ?? null, `${path}/input`, `Input for "${trigger.call}"`, diagnostics, trigger.input === undefined);
		}

		// Expressions read the target and nothing else: there is no viewer, slot or page data.
		const targetProps = schemaProperties(itemSchema);
		for (const key of ['where', 'input'] as const) {
			walkValue(trigger[key], `${path}/${key}`, (item, at) => {
				if (isDataRef(item) || isSlotRef(item) || isCan(item)) {
					error('build-trigger-expression', at, 'A trigger has no viewer, slot or data sources: read its target with "$target".');
				}
				if (isTargetRef(item) && targetProps && !targetProps.includes(item.$target.split('.')[0] ?? '')) {
					error('build-trigger-unknown-target-prop', at, `The target has no "${item.$target.split('.')[0]}". It has: ${targetProps.join(', ')}.`);
				}
			});
		}

		// Scopes: only what the spec lists for the trigger.
		if (spec) {
			for (const scope of triggerScopes(trigger, surface)) {
				if (!spec.permissions.includes(scope)) {
					diagnostics.push({
						severity: options.upgrade ? 'warning' : 'error',
						code: 'build-trigger-scope-not-requested',
						path,
						message: `Trigger "${id}" needs "${scope}", which the spec does not list for it.`,
					});
				}
			}
		}
	}
	return diagnostics;
}

/** The schema of a list's items in a capability's output, at a dotted path. */
function listItemSchema(output: JsonSchema, path: string): JsonSchema | undefined {
	let schema: unknown = output;
	for (const segment of path.split('.').filter(Boolean)) {
		const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
		schema = properties?.[segment];
	}
	return (schema as { items?: JsonSchema } | undefined)?.items;
}

/** The property names an object schema declares, or undefined when it does not say. */
function schemaProperties(schema: JsonSchema | undefined): string[] | undefined {
	const properties = typeof schema === 'object' ? (schema.properties as Record<string, unknown> | undefined) : undefined;
	return properties ? Object.keys(properties) : undefined;
}
