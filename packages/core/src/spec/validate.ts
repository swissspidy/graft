import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import specSchema from '../../../../schemas/spec.schema.json' with { type: 'json' };
import { hasErrors, type Diagnostic } from '../diagnostics.ts';
import { parseSpec } from './parse.ts';
import type { Spec, SpecManifest } from './types.ts';

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const validateManifest = ajv.compile<SpecManifest>(specSchema);

export interface SpecValidation {
	ok: boolean;
	/** Present when there are no errors. */
	spec?: Spec;
	diagnostics: Diagnostic[];
}

/**
 * Host-agnostic validation (phase one): parses the file and checks the
 * frontmatter against the spec schema. Checking mount, audience and
 * permissions against a surface is the host adapter's job (phase two).
 */
export function validateSpec(source: string): SpecValidation {
	const parsed = parseSpec(source);
	const diagnostics = [...parsed.diagnostics];

	const frontmatter = parsed.frontmatter;
	const isObject = typeof frontmatter === 'object' && frontmatter !== null && !Array.isArray(frontmatter);
	if (isObject && !validateManifest(frontmatter)) {
		for (const error of validateManifest.errors ?? []) {
			const path = schemaErrorPath(error);
			const line = parsed.lineOf(path);
			const diagnostic: Diagnostic = {
				severity: 'error',
				code: 'frontmatter-schema',
				message: describeSchemaError(error),
				path: path || '/',
			};
			if (line !== undefined) {
				diagnostic.line = line;
			}
			diagnostics.push(diagnostic);
		}
	}

	diagnostics.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

	if (hasErrors(diagnostics) || !isObject) {
		return { ok: false, diagnostics };
	}

	const spec: Spec = {
		manifest: frontmatter as SpecManifest,
		title: parsed.title,
		description: parsed.description,
		criteria: parsed.criteria,
		outOfScope: parsed.outOfScope,
		sections: parsed.sections,
	};
	if (parsed.notes !== undefined) {
		spec.notes = parsed.notes;
	}
	return { ok: true, spec, diagnostics };
}

function schemaErrorPath(error: ErrorObject): string {
	if (error.keyword === 'additionalProperties') {
		const extra = (error.params as { additionalProperty: string }).additionalProperty;
		return `${error.instancePath}/${extra}`;
	}
	return error.instancePath;
}

function describeSchemaError(error: ErrorObject): string {
	const where = error.instancePath ? `"${error.instancePath.slice(1).replace(/\//g, '.')}"` : 'The frontmatter';
	switch (error.keyword) {
		case 'required':
			return `${where} is missing required field "${(error.params as { missingProperty: string }).missingProperty}".`;
		case 'additionalProperties':
			return `${where} has unknown field "${(error.params as { additionalProperty: string }).additionalProperty}".`;
		case 'const':
			return `${where} must be ${JSON.stringify((error.params as { allowedValue: unknown }).allowedValue)}.`;
		case 'pattern':
			return `${where} has an invalid value (must match ${(error.params as { pattern: string }).pattern}).`;
		case 'uniqueItems':
			return `${where} contains duplicates.`;
		default:
			return `${where} ${error.message ?? 'is invalid'}.`;
	}
}
