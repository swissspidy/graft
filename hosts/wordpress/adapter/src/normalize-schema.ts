import type { JsonSchema } from '@graft/core';

type SchemaObject = Record<string, unknown>;

/** Keywords WordPress accepts in REST and ability schemas that are not JSON Schema. */
const WORDPRESS_ONLY = new Set(['context', 'arg_options', 'sanitize_callback', 'validate_callback', 'embeddable', 'readonly']);

/** Keywords whose value is a map of subschemas. */
const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions'];
/** Keywords whose value is a subschema. */
const SCHEMA_VALUES = ['additionalProperties', 'items', 'not', 'contains', 'propertyNames'];
/** Keywords whose value is a list of subschemas. */
const SCHEMA_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];

/**
 * Converts a WordPress ability schema (draft-04 flavored, serialized from
 * PHP) to JSON Schema draft 2020-12:
 *
 * - empty PHP arrays that stand for objects (`properties: []`, an object
 *   `default: []`) become `{}`;
 * - property-level `required: true` moves to the parent's `required` list;
 * - draft-04 boolean `exclusiveMinimum`/`exclusiveMaximum` become numbers;
 * - array-form `items` becomes `prefixItems`;
 * - WordPress-only keywords are dropped (`readonly` becomes `readOnly`).
 */
export function normalizeWordPressSchema(schema: unknown): JsonSchema {
	if (typeof schema === 'boolean') {
		return schema;
	}
	if (Array.isArray(schema) && schema.length === 0) {
		return {};
	}
	if (!isObject(schema)) {
		throw new TypeError(`Not a schema: ${JSON.stringify(schema)}`);
	}

	const out: SchemaObject = {};
	for (const [key, value] of Object.entries(schema)) {
		if (WORDPRESS_ONLY.has(key)) {
			if (key === 'readonly' && value === true) {
				out.readOnly = true;
			}
			continue;
		}
		if (key === 'required' && typeof value === 'boolean') {
			continue; // Hoisted into the parent below.
		}
		if (SCHEMA_MAPS.includes(key)) {
			out[key] = mapValues(emptyToObject(value), normalizeWordPressSchema);
		} else if (key === 'items' && Array.isArray(value)) {
			out.prefixItems = value.map(normalizeWordPressSchema);
		} else if (SCHEMA_VALUES.includes(key) && (isObject(value) || Array.isArray(value))) {
			out[key] = normalizeWordPressSchema(value);
		} else if (SCHEMA_LISTS.includes(key) && Array.isArray(value)) {
			out[key] = value.map(normalizeWordPressSchema);
		} else {
			out[key] = value;
		}
	}

	// Hoist draft-03 style `required: true` from properties.
	const properties = isObject(schema.properties) ? schema.properties : {};
	const hoisted = Object.entries(properties)
		.filter(([, property]) => isObject(property) && property.required === true)
		.map(([name]) => name);
	if (hoisted.length > 0) {
		const existing = Array.isArray(schema.required) ? (schema.required as string[]) : [];
		out.required = [...new Set([...existing, ...hoisted])];
	}

	for (const [keyword, bound] of [
		['exclusiveMinimum', 'minimum'],
		['exclusiveMaximum', 'maximum'],
	] as const) {
		if (typeof out[keyword] === 'boolean') {
			if (out[keyword] && typeof out[bound] === 'number') {
				out[keyword] = out[bound];
				delete out[bound];
			} else {
				delete out[keyword];
			}
		}
	}

	if (Array.isArray(out.default) && out.default.length === 0 && typeIncludes(out.type, 'object') && !typeIncludes(out.type, 'array')) {
		out.default = {};
	}

	return out;
}

function isObject(value: unknown): value is SchemaObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyToObject(value: unknown): SchemaObject {
	if (Array.isArray(value) && value.length === 0) {
		return {};
	}
	if (!isObject(value)) {
		throw new TypeError(`Expected a map of schemas: ${JSON.stringify(value)}`);
	}
	return value;
}

function mapValues(map: SchemaObject, fn: (value: unknown) => unknown): SchemaObject {
	return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, fn(value)]));
}

function typeIncludes(type: unknown, name: string): boolean {
	return type === name || (Array.isArray(type) && type.includes(name));
}
