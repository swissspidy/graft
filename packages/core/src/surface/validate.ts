import surfaceSchema from '../../../../schemas/surface.schema.json' with { type: 'json' };
import '../ajv.ts';
import { compileSchema, lazyValidator } from '../schema.ts';
import { hasErrors, type Diagnostic } from '../diagnostics.ts';
import { describeSchemaError, schemaErrorPath } from '../schema-errors.ts';
import { hashSurface } from './hash.ts';
import type { JsonSchema, Surface } from './types.ts';

const validateShape = lazyValidator<Surface>(surfaceSchema);

export interface SurfaceValidation {
	ok: boolean;
	/** Present when there are no errors. */
	surface?: Surface;
	/** Computed content hash, present when the shape is valid. */
	hash?: string;
	diagnostics: Diagnostic[];
}

/**
 * Validates a surface document: its shape, that every symbol it references
 * is declared, that embedded schemas compile, and that a stored hash matches
 * the content.
 */
export async function validateSurface(value: unknown): Promise<SurfaceValidation> {
	if (!validateShape(value)) {
		return {
			ok: false,
			diagnostics: (validateShape.errors ?? []).map((error) => ({
				severity: 'error',
				code: 'surface-schema',
				message: describeSchemaError(error, '', 'The surface'),
				path: schemaErrorPath(error) || '/',
			})),
		};
	}

	const surface = value;
	const diagnostics: Diagnostic[] = [];
	const error = (code: string, path: string, message: string) =>
		diagnostics.push({ severity: 'error', code, path, message });

	for (const [name, slot] of Object.entries(surface.slots)) {
		const path = `/slots/${escape(name)}`;
		if (slot.successor && !surface.slots[slot.successor]) {
			error('surface-unknown-slot', `${path}/successor`, `Slot "${name}" names unknown successor "${slot.successor}".`);
		}
		checkEmbedded(slot.options, `${path}/options`, diagnostics);
		checkEmbedded(slot.provides, `${path}/provides`, diagnostics);
	}

	for (const [name, capability] of Object.entries(surface.capabilities)) {
		const path = `/capabilities/${escape(name)}`;
		for (const scope of capability.scopes) {
			if (!surface.scopes[scope]) {
				error('surface-unknown-scope', `${path}/scopes`, `Capability "${name}" requires undeclared scope "${scope}".`);
			}
		}
		checkEmbedded(capability.input, `${path}/input`, diagnostics);
		checkEmbedded(capability.output, `${path}/output`, diagnostics);
	}

	if (surface.triggers) {
		surface.triggers.capabilities.forEach((name, i) => {
			if (!surface.capabilities[name]) {
				error('surface-unknown-capability', `/triggers/capabilities/${i}`, `Triggers may use "${name}", which the surface does not declare.`);
			}
		});
		for (const [name, event] of Object.entries(surface.triggers.events)) {
			checkEmbedded(event.provides, `/triggers/events/${escape(name)}/provides`, diagnostics);
		}
	}

	const collections = {
		slot: surface.slots,
		capability: surface.capabilities,
		scope: surface.scopes,
		event: surface.triggers?.events ?? {},
	};
	surface.migrations?.forEach((migration, i) => {
		if (migration.op === 'rename' && !collections[migration.kind][migration.to]) {
			error('surface-migration-target', `/migrations/${i}/to`, `Migration renames ${migration.kind} "${migration.from}" to "${migration.to}", which this surface does not declare.`);
		}
	});

	const hash = await hashSurface(surface);
	if (surface.hash !== undefined && surface.hash !== hash) {
		error('surface-hash-mismatch', '/hash', `The stored hash does not match the content (expected ${hash}). Regenerate the surface instead of editing it by hand.`);
	}

	if (hasErrors(diagnostics)) {
		return { ok: false, hash, diagnostics };
	}
	return { ok: true, surface, hash, diagnostics };
}

function checkEmbedded(schema: JsonSchema | undefined, path: string, diagnostics: Diagnostic[]): void {
	if (schema === undefined) {
		return;
	}
	try {
		compileSchema(schema);
	} catch (e) {
		diagnostics.push({
			severity: 'error',
			code: 'surface-invalid-schema',
			path,
			message: `Invalid embedded schema: ${e instanceof Error ? e.message : String(e)}`,
		});
	}
}

function escape(segment: string): string {
	return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}
