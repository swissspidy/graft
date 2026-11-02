import specSchema from '../../../../schemas/spec.schema.json' with { type: 'json' };
import '../ajv.ts';
import { lazyValidator } from '../schema.ts';
import { hasErrors, type Diagnostic } from '../diagnostics.ts';
import { describeSchemaError, schemaErrorPath } from '../schema-errors.ts';
import type { Surface } from '../surface/types.ts';
import { parseSpec } from './parse.ts';
import { checkManifestAgainstSurface } from './surface.ts';
import type { Spec, SpecManifest } from './types.ts';

const validateManifest = lazyValidator<SpecManifest>(specSchema);

export interface SpecValidation {
	ok: boolean;
	/** Present when there are no errors. */
	spec?: Spec;
	diagnostics: Diagnostic[];
}

export interface ValidateSpecOptions {
	/**
	 * Surface of the target host version. When given, mount, audience and
	 * permissions are checked against it (phase two).
	 */
	surface?: Surface;
}

/**
 * Validates a spec file. Phase one is host-agnostic: the file is parsed and
 * the frontmatter checked against the spec schema. Phase two runs when a
 * surface is given and the manifest passed phase one.
 */
export function validateSpec(source: string, options: ValidateSpecOptions = {}): SpecValidation {
	const parsed = parseSpec(source);
	const diagnostics = [...parsed.diagnostics];

	const frontmatter = parsed.frontmatter;
	const isObject = typeof frontmatter === 'object' && frontmatter !== null && !Array.isArray(frontmatter);
	let manifestOk = false;
	if (isObject) {
		manifestOk = validateManifest(frontmatter);
		for (const error of manifestOk ? [] : (validateManifest.errors ?? [])) {
			const path = schemaErrorPath(error);
			const diagnostic: Diagnostic = {
				severity: 'error',
				code: 'frontmatter-schema',
				message: describeSchemaError(error),
				path: path || '/',
			};
			const line = parsed.lineOf(path);
			if (line !== undefined) {
				diagnostic.line = line;
			}
			diagnostics.push(diagnostic);
		}
	}

	if (manifestOk && options.surface) {
		diagnostics.push(...checkManifestAgainstSurface(frontmatter as SpecManifest, options.surface, parsed.lineOf));
	}

	diagnostics.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

	if (hasErrors(diagnostics) || !manifestOk) {
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
	spec.lines = manifestLines(frontmatter, parsed.lineOf);
	return { ok: true, spec, diagnostics };
}

/**
 * The line of every key and item in the frontmatter, by JSON pointer. YAML
 * aliases can make the frontmatter cyclic (`mount: &m { extra: *m }`), so
 * a value already on the path is not entered again.
 */
function manifestLines(value: unknown, lineOf: (pointer: string) => number | undefined): Record<string, number> {
	const lines: Record<string, number> = {};
	const path = new Set<object>();
	const walk = (node: unknown, pointer: string) => {
		const line = lineOf(pointer);
		if (line !== undefined && pointer !== '') {
			lines[pointer] = line;
		}
		if (node !== null && typeof node === 'object' && !path.has(node)) {
			path.add(node);
			for (const [key, child] of Object.entries(node)) {
				walk(child, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
			}
			path.delete(node);
		}
	};
	walk(value, '');
	return lines;
}
