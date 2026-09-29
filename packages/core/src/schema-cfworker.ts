import { Validator as CfValidator, type OutputUnit, type Schema } from '@cfworker/json-schema';
import type { SchemaEngine, SchemaError, Validator } from './schema.ts';

/**
 * A JSON Schema engine for runtimes that forbid code generation (Workers,
 * the EmDash plugin sandbox), on @cfworker/json-schema. Errors are mapped
 * to Ajv's shape so diagnostics read the same:
 *
 *   import { setSchemaEngine } from '@graft/core';
 *   import { cfworkerEngine } from '@graft/core/cfworker';
 *   setSchemaEngine(cfworkerEngine());
 *
 * Unlike Ajv it does not reject unknown keywords in schemas, so surfaces
 * should still be validated with Ajv where they are generated.
 */

/** Entries that only summarize errors reported on their own. */
const SUMMARIES = new Set(['properties', 'items', 'prefixItems', '$ref', '$dynamicRef', 'allOf', 'false', 'dependentSchemas', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'then', 'else', 'propertyNames']);

const quoted = (text: string, pattern: RegExp) => pattern.exec(text)?.[1];

function parseJson(text: string | undefined): unknown {
	if (text === undefined) {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** Follows a keyword location (`#/items/$ref/pattern`) through local $refs. */
function resolveKeyword(root: unknown, location: string): unknown {
	let current: unknown = root;
	for (const raw of location.replace(/^#\/?/, '').split('/').filter(Boolean)) {
		const segment = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
		if (current === null || typeof current !== 'object') {
			return undefined;
		}
		if (segment === '$ref') {
			const ref = (current as { $ref?: unknown }).$ref;
			if (typeof ref !== 'string' || !ref.startsWith('#')) {
				return undefined;
			}
			current = resolveKeyword(root, ref);
			continue;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * cfworker also reports declared properties that failed their own schema
 * under additionalProperties; Ajv (and the schema's intent) do not.
 */
function isDeclaredProperty(unit: OutputUnit, schema: unknown): boolean {
	if (unit.keyword !== 'additionalProperties') {
		return false;
	}
	const name = quoted(unit.error, /Property "(.*)" does not match/);
	const parent = resolveKeyword(schema, unit.keywordLocation.replace(/\/additionalProperties$/, '')) as
		| { properties?: Record<string, unknown>; patternProperties?: Record<string, unknown> }
		| undefined;
	if (name === undefined || !parent) {
		return false;
	}
	return Object.hasOwn(parent.properties ?? {}, name) || Object.keys(parent.patternProperties ?? {}).some((pattern) => new RegExp(pattern, 'u').test(name));
}

function toSchemaError(unit: OutputUnit, schema: unknown): SchemaError {
	const instancePath = unit.instanceLocation.replace(/^#/, '');
	const base = { keyword: unit.keyword, instancePath, schemaPath: unit.keywordLocation };
	const lower = unit.error.replace(/\.$/, '');
	switch (unit.keyword) {
		case 'required':
			return { ...base, params: { missingProperty: quoted(unit.error, /property "(.*)"/) ?? '' }, message: 'must have required property' };
		case 'additionalProperties':
			return { ...base, params: { additionalProperty: quoted(unit.error, /Property "(.*)" does not match/) ?? '' }, message: 'must NOT have additional properties' };
		case 'enum': {
			const values = resolveKeyword(schema, unit.keywordLocation);
			return { ...base, params: { allowedValues: Array.isArray(values) ? values : (parseJson(quoted(unit.error, /any of (.*)\.$/)) ?? []) }, message: 'must be equal to one of the allowed values' };
		}
		case 'const': {
			const value = resolveKeyword(schema, unit.keywordLocation);
			return { ...base, params: { allowedValue: value !== undefined ? value : parseJson(quoted(unit.error, /match (.*)\.$/)) }, message: 'must be equal to constant' };
		}
		case 'pattern':
			return { ...base, params: { pattern: String(resolveKeyword(schema, unit.keywordLocation) ?? '') }, message: 'must match pattern' };
		case 'type': {
			const expected = quoted(unit.error, /Expected "(.*)"/) ?? '';
			return { ...base, params: { type: expected }, message: `must be ${expected.replace(/", "/g, ',')}` };
		}
		case 'format':
			return { ...base, params: { format: quoted(unit.error, /format "(.*)"/) ?? '' }, message: `must match format "${quoted(unit.error, /format "(.*)"/) ?? ''}"` };
		case 'anyOf':
			return { ...base, params: {}, message: 'must match a schema in anyOf' };
		case 'oneOf':
			return { ...base, params: {}, message: 'must match exactly one schema in oneOf' };
		default:
			return { ...base, params: {}, message: lower.charAt(0).toLowerCase() + lower.slice(1) };
	}
}

export function cfworkerEngine(): SchemaEngine {
	return {
		compile(schema) {
			// The library annotates the schema objects it is given; keep ours intact.
			const own = typeof schema === 'boolean' ? schema : (structuredClone(schema) as Schema);
			// Graft's schemas only use local refs (#/...). Resolving them against
			// an absolute $id goes wrong under workerd, so resolve them locally.
			if (typeof own === 'object') {
				delete own.$id;
			}
			const reference = typeof schema === 'boolean' ? schema : structuredClone(schema);
			const validator = new CfValidator(own, '2020-12', false);
			const validate: Validator = (data: unknown) => {
				const result = validator.validate(data);
				validate.errors = result.valid ? null : result.errors.filter((unit) => !SUMMARIES.has(unit.keyword) && !isDeclaredProperty(unit, reference)).map((unit) => toSchemaError(unit, reference));
				return result.valid;
			};
			validate.errors = null;
			return validate;
		},
	};
}
