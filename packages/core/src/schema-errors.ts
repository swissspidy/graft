import type { ErrorObject } from 'ajv';

/** JSON pointer of the value an Ajv error is about. */
export function schemaErrorPath(error: ErrorObject): string {
	if (error.keyword === 'additionalProperties') {
		const extra = (error.params as { additionalProperty: string }).additionalProperty;
		return `${error.instancePath}/${extra}`;
	}
	return error.instancePath;
}

/** A plain-language message for an Ajv error, `prefix` being the pointer the instance lives at. */
export function describeSchemaError(error: ErrorObject, prefix = '', subject = 'The frontmatter'): string {
	const pointer = prefix + error.instancePath;
	const where = pointer ? `"${pointer.slice(1).replace(/\//g, '.')}"` : subject;
	switch (error.keyword) {
		case 'required':
			return `${where} is missing required field "${(error.params as { missingProperty: string }).missingProperty}".`;
		case 'additionalProperties':
			return `${where} has unknown field "${(error.params as { additionalProperty: string }).additionalProperty}".`;
		case 'const':
			return `${where} must be ${JSON.stringify((error.params as { allowedValue: unknown }).allowedValue)}.`;
		case 'enum':
			return `${where} must be one of: ${(error.params as { allowedValues: unknown[] }).allowedValues.map((v) => JSON.stringify(v)).join(', ')}.`;
		case 'pattern':
			return `${where} has an invalid value (must match ${(error.params as { pattern: string }).pattern}).`;
		case 'uniqueItems':
			return `${where} contains duplicates.`;
		default:
			return `${where} ${error.message ?? 'is invalid'}.`;
	}
}
